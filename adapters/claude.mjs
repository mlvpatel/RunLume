import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  UUID_RE,
  newSession,
  isInjectedMetadataText,
  readJsonLines,
  readJsonDocument,
  parseGenericAgentFile,
  SPAWN_TOOL_RE,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  MAX_SESSION_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  INJECTED_METADATA_TAGS,
  maxTranscriptBytes,
  tokenCount,
  tokenSum,
  boundedIdentifier,
  normalizedTimestamp,
  firstText,
  assignSessionModel,
  blocksOf,
  textOf,
  assignSessionId,
  normalizedUsage,
  recordUsage,
  appendUsage,
  readDiagnostics,
  openTranscript,
  nestedUuids,
  addToolCall,
  attachResult,
  touch,
  finalizeLabel,
  isLexicallyWithin,
  safeReaddir,
  safeChildPath,
  walkJsonl,
  walkJsonTranscripts,
  fileModifiedTimestamp,
  parseGenericMessage,
} from './shared.mjs';
// ── Claude Code (~/.claude/projects/<munged-cwd>/<sessionId>.jsonl) ──────────
const CC_SKIP_TYPES = new Set([
  'attachment', 'file-history-snapshot', 'file-history-delta', 'last-prompt',
  'mode', 'permission-mode', 'progress', 'queued-prompt',
]);

function ccParseMessageInto(session, pending, obj, diagnostics) {
  const ts = normalizedTimestamp(obj.timestamp);
  if (obj.type === 'system') {
    touch(session, ts);
    if (typeof obj.cwd === 'string' && obj.cwd) session.cwd ??= obj.cwd;
    if (!obj.isMeta) session.events.push({ kind: 'meta', ts, text: obj.subtype ?? 'system' });
    return;
  }
  if (obj.isMeta) return;
  parseGenericMessage(session, pending, obj, diagnostics);
  if (typeof obj.cwd === 'string' && obj.cwd) session.cwd ??= obj.cwd;
}

export function parseClaudeCodeFile(file, projectDir, maxBytes = maxTranscriptBytes()) {
  const main = newSession('claude-code', file, projectDir);
  const pendingMain = new Map();
  let title = null;
  const sidechainLines = [];

  const { diagnostics } = readJsonLines(file, maxBytes, (obj, rowDiagnostics) => {
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle) {
      title = obj.aiTitle;
      return;
    }
    if (obj.type === 'summary' && typeof obj.summary === 'string' && obj.summary) {
      title ??= obj.summary;
      return;
    }
    if (CC_SKIP_TYPES.has(obj.type)) return;
    if (obj.isSidechain) { sidechainLines.push(obj); return; }
    if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'system') {
      ccParseMessageInto(main, pendingMain, obj, rowDiagnostics);
      if (main.cwd && main.agent === projectDir) main.agent = path.basename(main.cwd);
    }
  });
  if (title) main.label = title;
  finalizeLabel(main);

  // Sidechains = Task sub-agent transcripts stored in the same file. Group the
  // sidechain entries into chains by walking parentUuid to each chain's root.
  const byUuid = new Map(
    sidechainLines
      .filter((entry) => typeof entry.uuid === 'string' && entry.uuid)
      .map((entry) => [entry.uuid, entry]),
  );
  const sidechainIndexes = new Map(sidechainLines.map((entry, index) => [entry, index]));
  const rootCache = new Map();
  const rootOf = (entry) => {
    const trail = [];
    const positions = new Map();
    let current = entry;
    let root = null;
    while (current) {
      const uuid = typeof current.uuid === 'string' && current.uuid
        ? current.uuid
        : null;
      if (uuid) {
        if (rootCache.has(uuid)) {
          root = rootCache.get(uuid);
          break;
        }
        if (positions.has(uuid)) {
          const cycle = trail.slice(positions.get(uuid));
          root = [...cycle].sort()[0];
          break;
        }
        positions.set(uuid, trail.length);
        trail.push(uuid);
      }
      if (typeof current.parentUuid === 'string' && byUuid.has(current.parentUuid)) {
        current = byUuid.get(current.parentUuid);
        continue;
      }
      root = uuid ?? `unidentified-${sidechainIndexes.get(current) ?? sidechainIndexes.get(entry) ?? 0}`;
      break;
    }
    root ??= `unidentified-${sidechainIndexes.get(entry) ?? 0}`;
    for (const uuid of trail) rootCache.set(uuid, root);
    return root;
  };
  const chains = new Map();
  for (const o of sidechainLines) {
    const r = rootOf(o);
    if (!chains.has(r)) chains.set(r, []);
    chains.get(r).push(o);
  }
  const sessions = [main];
  let i = 0;
  for (const [, chain] of chains) {
    const child = newSession('claude-code', file, main.agent);
    child.id = `${main.id}-sub${i++}`;
    child.parent = main.id;
    child.intrinsicParent = main.id;
    child.cwd = main.cwd;
    const pending = new Map();
    chain.sort((a, b) => (
      (normalizedTimestamp(a.timestamp) ?? '').localeCompare(normalizedTimestamp(b.timestamp) ?? '')
    ));
    for (const obj of chain) {
      try {
        ccParseMessageInto(child, pending, obj, diagnostics);
      } catch {
        diagnostics.rowErrors++;
      }
    }
    if (!child.events.length) continue;
    if (!child.label) child.label = '(sub-agent)';
    main.children.push(child.id);
    main.intrinsicChildren.push(child.id);
    sessions.push(child);
    // link the Task/Agent tool call whose prompt matches this chain's first user text
    const firstUser = child.events.find((e) => e.kind === 'user')?.text ?? '';
    for (const ev of main.events) {
      if (ev.kind !== 'tool' || ev.tool.spawnTarget || !SPAWN_TOOL_RE.test(ev.tool.name)) continue;
      const prompt = typeof ev.tool.args?.prompt === 'string' ? ev.tool.args.prompt : '';
      if (prompt && firstUser && (prompt.startsWith(firstUser.slice(0, 60)) || firstUser.startsWith(prompt.slice(0, 60)))) {
        ev.tool.spawnTarget = child.id;
        ev.tool.intrinsicSpawnTarget = child.id;
        break;
      }
    }
  }
  const kept = sessions.filter((s) => s.events.length || s.children.length);
  return { sessions: kept, diagnostics };
}

function claudeCodeAdapter(maxBytes) {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects')
    : path.join(os.homedir(), '.claude', 'projects');
  return {
    source: 'claude-code',
    *findFiles() {
      for (const proj of safeReaddir(root, root)) {
        const dir = safeChildPath(root, root, proj);
        if (!dir) continue;
        for (const f of walkJsonl(dir, 2)) yield { file: f, agent: proj, root };
      }
    },
    parseFile: ({ file, agent }) => parseClaudeCodeFile(file, agent, maxBytes),
  };
}

export {
  CC_SKIP_TYPES,
  ccParseMessageInto,
  claudeCodeAdapter,
};
