/**
 * Source adapters: each discovers session transcript files for one agent CLI
 * and parses them into the shared normalized trajectory model:
 *
 *   session: { id, source, agent, file, label, model, startedAt, endedAt,
 *              events[], stats, spawnCandidates[], children[], parent }
 *   event:   { kind: user|assistant|thinking|tool|meta, ts, text?, tool? }
 *   tool:    { id, name, args, result, isError, resultTs, confirmed?,
 *              spawnTarget? }
 *
 * All adapters are read-only and tolerant: unparseable lines are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SPAWN_TOOL_RE = /spawn|subagent|sub_agent|^task$|^agent$/i;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 512;
const MAX_TOOL_NAME_LENGTH = 160;
const MAX_MODEL_NAME_LENGTH = 160;
const INJECTED_METADATA_TAGS = new Set([
  'agent_context',
  'app-context',
  'apps_instructions',
  'collaboration_mode',
  'environment_context',
  'in-app-browser-context',
  'memory',
  'permissions',
  'permissions_instructions',
  'plugins_instructions',
  'recommended_plugins',
  'skills_instructions',
  'system-reminder',
]);

function maxTranscriptBytes() {
  const configured = Number(process.env.RUNLUME_MAX_FILE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_TRANSCRIPT_BYTES;
}

function tokenCount(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())
  ) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

function tokenSum(...values) {
  return values.reduce(
    (sum, value) => Math.min(Number.MAX_SAFE_INTEGER, sum + tokenCount(value)),
    0,
  );
}

function boundedIdentifier(value, maxLength, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : fallback;
}

function normalizedTimestamp(value) {
  if (typeof value !== 'string' || !value || value.length > 128) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function firstText(...values) {
  return values.find((value) => typeof value === 'string') ?? '';
}

function assignSessionModel(session, value) {
  const model = boundedIdentifier(value, MAX_MODEL_NAME_LENGTH);
  if (model) session.model = model;
  return model;
}

// ── shared helpers ───────────────────────────────────────────────────────────
export function newSession(source, file, agent) {
  const fallbackId = path.basename(file, '.jsonl').slice(0, MAX_SESSION_ID_LENGTH) || `${source}-session`;
  return {
    id: fallbackId,
    source,
    agent,
    file,
    label: '',
    model: null,
    provider: null,
    runtime: null,
    cwd: null,
    startedAt: null,
    endedAt: null,
    events: [],
    usage: [],
    stats: { toolCounts: Object.create(null), tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, messages: 0, errors: 0 },
    spawnCandidates: [],
    children: [],
    parent: null,
    intrinsicChildren: [],
    intrinsicParent: null,
  };
}

function blocksOf(content) {
  if (content == null) return [];
  const values = Array.isArray(content) ? content : [content];
  return values.map((block) => {
    if (typeof block === 'string') return { type: 'text', text: block };
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      throw new TypeError('message content contains an invalid block');
    }
    for (const field of ['text', 'thinking']) {
      if (block[field] != null && typeof block[field] !== 'string') {
        throw new TypeError(`message block ${field} must be a string`);
      }
    }
    return block;
  });
}

function textOf(content) {
  return blocksOf(content)
    .map((block) => firstText(block.text, block.thinking))
    .filter(Boolean)
    .join('\n');
}

export function isInjectedMetadataText(value) {
  if (typeof value !== 'string') return false;
  if (/^\s*# AGENTS\.md instructions\b/i.test(value)) return true;
  const match = /^\s*<([a-z][\w-]*)(?:\s[^>]*)?>/i.exec(value);
  return Boolean(match && INJECTED_METADATA_TAGS.has(match[1].toLowerCase()));
}

function assignSessionId(session, value, diagnostics) {
  const valid = typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= MAX_SESSION_ID_LENGTH;
  if (!valid) {
    diagnostics.invalidSessionIds++;
    return false;
  }
  session.id = value.trim();
  return true;
}

function normalizedUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const cacheRead = tokenCount(usage.cacheRead ?? usage.cache_read_input_tokens);
  const cacheWrite5m = tokenCount(usage.cacheWrite5m
    ?? usage.cache_creation_5m_input_tokens
    ?? usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite1h = tokenCount(usage.cacheWrite1h
    ?? usage.cache_creation_1h_input_tokens
    ?? usage.cache_creation?.ephemeral_1h_input_tokens);
  const explicitCacheWrite = usage.cacheWrite ?? usage.cache_creation_input_tokens;
  const cacheWrite = explicitCacheWrite == null
    ? tokenSum(cacheWrite5m, cacheWrite1h)
    : tokenCount(explicitCacheWrite);
  const input = tokenSum(usage.input ?? usage.input_tokens, cacheRead, cacheWrite);
  const output = tokenCount(usage.output ?? usage.output_tokens);
  return { input, output, cacheRead, cacheWrite, cacheWrite5m, cacheWrite1h };
}

function recordUsage(session, usage, ts, model) {
  const normalized = normalizedUsage(usage);
  if (!normalized) return;
  appendUsage(session, normalized, ts, model);
}

function appendUsage(session, normalized, ts, model) {
  const safe = {
    input: tokenCount(normalized?.input),
    output: tokenCount(normalized?.output),
    cacheRead: tokenCount(normalized?.cacheRead),
    cacheWrite: tokenCount(normalized?.cacheWrite),
    cacheWrite5m: tokenCount(normalized?.cacheWrite5m),
    cacheWrite1h: tokenCount(normalized?.cacheWrite1h),
  };
  // "in" is the full context the model saw (cache reads/writes included)
  session.stats.tokensIn = tokenSum(session.stats.tokensIn, safe.input);
  session.stats.tokensOut = tokenSum(session.stats.tokensOut, safe.output);
  session.stats.tokensCacheRead = tokenSum(session.stats.tokensCacheRead, safe.cacheRead);
  session.stats.tokensCacheWrite = tokenSum(session.stats.tokensCacheWrite, safe.cacheWrite);
  session.usage.push({
    ts,
    model: boundedIdentifier(model, MAX_MODEL_NAME_LENGTH),
    ...safe,
  });
}

function readDiagnostics(file, streamed) {
  return {
    file,
    bytes: 0,
    lines: 0,
    parsedLines: 0,
    malformedLines: 0,
    invalidRows: 0,
    rowErrors: 0,
    orphanResults: 0,
    invalidSessionIds: 0,
    readError: null,
    tooLarge: false,
    symlinkRejected: false,
    streamed,
  };
}

function openTranscript(file, maxBytes, diagnostics) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(file);
    diagnostics.bytes = opened.size;
    if (!opened.isFile()) throw new Error('transcript is not a regular file');
    if (named.isSymbolicLink()) {
      diagnostics.symlinkRejected = true;
      throw new Error('transcript symbolic links are not accepted');
    }
    if (
      (named.dev !== 0 || opened.dev !== 0 || named.ino !== 0 || opened.ino !== 0)
      && (named.dev !== opened.dev || named.ino !== opened.ino)
    ) {
      throw new Error('transcript changed while it was being opened');
    }
    if (opened.size > maxBytes) {
      diagnostics.tooLarge = true;
      fs.closeSync(descriptor);
      return null;
    }
  } catch (err) {
    if (err?.code === 'ELOOP') diagnostics.symlinkRejected = true;
    if (descriptor != null) {
      try { fs.closeSync(descriptor); } catch { /* already closed */ }
    }
    diagnostics.readError = err instanceof Error ? err.message : String(err);
    return null;
  }
  return descriptor;
}

export function readJsonLines(file, maxBytes = maxTranscriptBytes(), onRow = null) {
  const diagnostics = readDiagnostics(file, true);
  const descriptor = openTranscript(file, maxBytes, diagnostics);
  if (descriptor == null) return { rows: [], diagnostics };
  const out = [];
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let pendingParts = [];
  const processLine = (line) => {
    if (!line.trim()) return;
    diagnostics.lines++;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      diagnostics.malformedLines++;
      return;
    }
    diagnostics.parsedLines++;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      diagnostics.invalidRows++;
      return;
    }
    if (onRow) {
      try {
        onRow(row, diagnostics);
      } catch {
        diagnostics.rowErrors++;
      }
    } else {
      out.push(row);
    }
  };
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const parts = decoder.write(buffer.subarray(0, bytesRead)).split('\n');
      if (parts.length === 1) {
        pendingParts.push(parts[0]);
        continue;
      }
      processLine(`${pendingParts.join('')}${parts[0]}`.replace(/\r$/, ''));
      for (let index = 1; index < parts.length - 1; index++) {
        processLine(parts[index].replace(/\r$/, ''));
      }
      pendingParts = [parts.at(-1)];
    }
    pendingParts.push(decoder.end());
    const pending = pendingParts.join('');
    if (pending) processLine(pending.replace(/\r$/, ''));
  } catch (err) {
    diagnostics.readError = err instanceof Error ? err.message : String(err);
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
  return { rows: out, diagnostics };
}

export function readJsonDocument(file, maxBytes = maxTranscriptBytes(), onRow = null) {
  const diagnostics = readDiagnostics(file, false);
  const descriptor = openTranscript(file, maxBytes, diagnostics);
  if (descriptor == null) return { rows: [], diagnostics };
  let body;
  try {
    body = fs.readFileSync(descriptor, 'utf8');
  } catch (err) {
    diagnostics.readError = err instanceof Error ? err.message : String(err);
    return { rows: [], diagnostics };
  } finally {
    fs.closeSync(descriptor);
  }

  const out = [];
  const accept = (row) => {
    diagnostics.parsedLines++;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      diagnostics.invalidRows++;
      return;
    }
    if (onRow) {
      try {
        onRow(row, diagnostics);
      } catch {
        diagnostics.rowErrors++;
      }
    } else {
      out.push(row);
    }
  };
  diagnostics.lines = 1;
  let document;
  try {
    document = JSON.parse(body);
  } catch {
    diagnostics.malformedLines = 1;
    return { rows: out, diagnostics };
  }
  for (const row of Array.isArray(document) ? document : [document]) accept(row);
  return { rows: out, diagnostics };
}

function nestedUuids(value) {
  const found = new Set();
  const seen = new WeakSet();
  const stack = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length && visited < 10_000) {
    const current = stack.pop();
    visited++;
    if (typeof current.value === 'string') {
      for (const uuid of current.value.match(UUID_RE) ?? []) found.add(uuid.toLowerCase());
      continue;
    }
    if (
      !current.value
      || typeof current.value !== 'object'
      || current.depth >= 64
      || seen.has(current.value)
    ) continue;
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (let index = Math.min(values.length, 1_000) - 1; index >= 0; index--) {
      stack.push({ value: values[index], depth: current.depth + 1 });
    }
  }
  return [...found];
}

function addToolCall(session, pending, ts, { id, name, args }) {
  const toolName = boundedIdentifier(name, MAX_TOOL_NAME_LENGTH, 'tool');
  const safeArgs = args ?? {};
  const spawnUuids = SPAWN_TOOL_RE.test(toolName) ? nestedUuids(safeArgs) : [];
  const eventTs = normalizedTimestamp(ts);
  const ev = {
    kind: 'tool',
    ts: eventTs,
    tool: {
      id: id ?? null,
      name: toolName,
      args: safeArgs,
      result: null,
      isError: false,
      resultTs: null,
    },
  };
  session.stats.toolCounts[toolName] = tokenSum(session.stats.toolCounts[toolName], 1);
  session.events.push(ev);
  if (id) pending.set(id, ev);
  for (const uuid of spawnUuids) session.spawnCandidates.push({ uuid, ev, ts: eventTs });
  return ev;
}

function attachResult(session, pending, callId, text, isError, ts, diagnostics = null, fallbackEvent = null) {
  const ev = (callId && pending.get(callId)) || fallbackEvent;
  if (ev) {
    const safeText = typeof text === 'string' ? text : '';
    const spawnUuids = SPAWN_TOOL_RE.test(ev.tool.name) ? nestedUuids(safeText) : [];
    const resultTs = normalizedTimestamp(ts);
    ev.tool.result = safeText;
    ev.tool.isError = Boolean(isError);
    ev.tool.resultTs = resultTs;
    if (callId) pending.delete(callId);
    for (const uuid of spawnUuids) session.spawnCandidates.push({ uuid, ev, ts: resultTs });
    if (isError) session.stats.errors++;
  } else if (callId && diagnostics) {
    diagnostics.orphanResults++;
  }
}

function touch(session, ts) {
  const normalized = normalizedTimestamp(ts);
  if (!normalized) return null;
  const ms = Date.parse(normalized);
  if (!session.startedAt || ms < Date.parse(session.startedAt)) session.startedAt = normalized;
  if (!session.endedAt || ms > Date.parse(session.endedAt)) session.endedAt = normalized;
  return normalized;
}

function finalizeLabel(session) {
  if (!session.label) {
    const first = session.events.find((e) => e.kind === 'user' || e.kind === 'assistant');
    session.label = typeof first?.text === 'string' ? first.text.slice(0, 100) : '(empty session)';
  }
}

function isLexicallyWithin(root, target) {
  const base = path.resolve(root);
  const candidate = path.resolve(target);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

function safeReaddir(root, directory = root) {
  if (!isLexicallyWithin(root, directory)) return [];
  try { return fs.readdirSync(path.resolve(directory)); } catch { return []; }
}

function safeChildPath(root, directory, name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const parent = path.resolve(directory);
  if (!isLexicallyWithin(root, parent)) return null;
  const candidate = path.resolve(parent, name);
  if (path.dirname(candidate) !== parent || !isLexicallyWithin(root, candidate)) return null;
  return candidate;
}

function* walkJsonl(dir, depth = 4, root = dir) {
  for (const name of safeReaddir(root, dir)) {
    const p = safeChildPath(root, dir, name);
    if (!p) continue;
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      if (name.endsWith('.jsonl')) yield p;
      continue;
    }
    if (st.isDirectory() && depth > 0) yield* walkJsonl(p, depth - 1, root);
    else if (st.isFile() && name.endsWith('.jsonl')) yield p;
  }
}

function* walkJsonTranscripts(dir, depth = 4, root = dir) {
  for (const name of safeReaddir(root, dir)) {
    const p = safeChildPath(root, dir, name);
    if (!p) continue;
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) {
      if (/\.(?:jsonl|json)$/i.test(name)) yield p;
      continue;
    }
    if (st.isDirectory() && depth > 0) yield* walkJsonTranscripts(p, depth - 1, root);
    else if (st.isFile() && /\.(?:jsonl|json)$/i.test(name)) yield p;
  }
}

function fileModifiedTimestamp(file) {
  try {
    const value = fs.lstatSync(file).mtime;
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  } catch {
    return null;
  }
}

// ── Generic message parser used by Hermes ───────────────────────────────────
function parseGenericMessage(session, pending, obj, diagnostics = null) {
  const hasMessageEnvelope = Object.hasOwn(obj, 'message');
  if (
    hasMessageEnvelope
    && (!obj.message || typeof obj.message !== 'object' || Array.isArray(obj.message))
  ) {
    throw new TypeError('message envelope must be an object');
  }
  const m = hasMessageEnvelope ? obj.message : (obj.role ? obj : null);
  if (!m) {
    if (typeof obj.type === 'string' && obj.type !== 'session') {
      session.events.push({ kind: 'meta', ts: normalizedTimestamp(obj.timestamp), text: obj.type });
    }
    return;
  }
  const ts = normalizedTimestamp(obj.timestamp ?? m.timestamp);
  const role = m.role;
  if (!['assistant', 'system', 'toolResult', 'tool', 'user'].includes(role)) {
    throw new TypeError('message envelope has an unsupported role');
  }
  const blocks = role === 'assistant' || role === 'system' || role === 'user'
    ? blocksOf(m.content)
    : null;
  const directResult = role === 'toolResult' || role === 'tool'
    ? textOf(m.content ?? m.output ?? m.result ?? '')
    : null;
  const userResults = role === 'user'
    ? blocks
      .filter((block) => block.type === 'tool_result' || block.type === 'toolResult')
      .map((block) => ({
        id: block.tool_use_id ?? block.toolCallId,
        text: textOf(block.content ?? ''),
        isError: block.is_error ?? block.isError,
      }))
    : [];
  const userText = role === 'user'
    ? blocks
      .filter((block) => (block.type ?? 'text') === 'text')
      .map((block) => firstText(block.text))
      .filter(Boolean)
      .join('\n')
    : '';
  touch(session, ts);

  if (role === 'assistant') {
    session.stats.messages++;
    const messageModel = assignSessionModel(session, m.model);
    recordUsage(session, m.usage, ts, messageModel ?? session.model);
    for (const b of blocks) {
      const t = b.type ?? 'text';
      if (t === 'thinking' || t === 'redacted_thinking') {
        const text = firstText(b.thinking, b.text);
        if (text) session.events.push({ kind: 'thinking', ts, text });
      } else if (t === 'text' && typeof b.text === 'string' && b.text) {
        session.events.push({ kind: 'assistant', ts, text: b.text });
      }
      else if (t === 'toolCall' || t === 'tool_use' || t === 'toolUse')
        addToolCall(session, pending, ts, { id: b.id ?? b.toolCallId, name: b.name ?? b.toolName ?? 'tool', args: b.arguments ?? b.input });
    }
  } else if (role === 'toolResult' || role === 'tool') {
    attachResult(session, pending, m.toolCallId ?? m.tool_call_id ?? m.id, directResult, m.isError ?? m.is_error, ts, diagnostics);
  } else if (role === 'user') {
    if (userResults.length) {
      for (const result of userResults) {
        attachResult(session, pending, result.id, result.text, result.isError, ts, diagnostics);
      }
    }
    if (userText && !isInjectedMetadataText(userText)) {
      session.stats.messages++;
      session.events.push({ kind: 'user', ts, text: userText });
      if (!session.label) session.label = userText.slice(0, 100);
    }
  }
}

export function parseGenericAgentFile(source, file, agent, maxBytes = maxTranscriptBytes()) {
  const session = newSession(source, file, agent);
  const pending = new Map();
  const { diagnostics } = readJsonLines(file, maxBytes, (obj, rowDiagnostics) => {
    if (obj.type === 'session') {
      if (Object.hasOwn(obj, 'id')) assignSessionId(session, obj.id, rowDiagnostics);
      if (typeof obj.cwd === 'string' && obj.cwd) session.cwd = obj.cwd;
      touch(session, obj.timestamp);
      return;
    }
    if (obj.type === 'model_change' && typeof obj.model === 'string') {
      assignSessionModel(session, obj.model);
      return;
    }
    parseGenericMessage(session, pending, obj, rowDiagnostics);
  });
  finalizeLabel(session);
  return { sessions: session.events.length ? [session] : [], diagnostics };
}

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

// ── Codex CLI (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) ─────────────────
function codexOutput(raw) {
  let parsed = raw;
  if (typeof raw === 'string' && raw.trimStart().startsWith('{')) {
    try { parsed = JSON.parse(raw); } catch { /* preserve raw output */ }
  }
  if (!parsed || typeof parsed !== 'object') {
    const text = String(parsed ?? '');
    return {
      text,
      isError: /(?:exited with code (?!0\b)\d+|process exited with code (?!0\b)\d+|script (?:failed|error))/i.test(text.slice(0, 1000)),
    };
  }
  const exitCode = parsed.exit_code ?? parsed.exitCode ?? parsed.code;
  const isError = parsed.is_error === true
    || parsed.isError === true
    || parsed.success === false
    || parsed.error != null
    || (exitCode != null && Number(exitCode) !== 0);
  const value = parsed.output ?? parsed.text ?? parsed.content ?? parsed.error ?? raw;
  return { text: typeof value === 'string' ? value : JSON.stringify(value), isError };
}

export function parseCodexFile(file, maxBytes = maxTranscriptBytes()) {
  const session = newSession('codex', file, 'codex');
  const basename = path.basename(file);
  const stem = basename.toLowerCase().endsWith('.jsonl')
    ? basename.slice(0, -'.jsonl'.length)
    : '';
  const candidateId = stem.slice(-36);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidateId)) {
    session.id = candidateId.toLowerCase();
  }
  const pending = new Map();
  let currentModel = null;
  let previousUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const { diagnostics } = readJsonLines(file, maxBytes, (obj, rowDiagnostics) => {
    const ts = normalizedTimestamp(obj.timestamp);
    if (
      Object.hasOwn(obj, 'payload')
      && (!obj.payload || typeof obj.payload !== 'object' || Array.isArray(obj.payload))
    ) {
      throw new TypeError('Codex payload must be an object');
    }
    const p = obj.payload ?? obj; // older codex versions have no payload wrapper
    const type = p.type ?? obj.type;

    if (obj.type === 'session_meta') {
      if (Object.hasOwn(p, 'id')) assignSessionId(session, p.id, rowDiagnostics);
      if (typeof p.cwd === 'string' && p.cwd) {
        session.cwd = p.cwd;
        session.agent = path.basename(p.cwd);
      }
      touch(session, p.timestamp ?? ts);
      return;
    }
    if (obj.type === 'turn_context') {
      if (p.model) {
        currentModel = p.model;
        assignSessionModel(session, p.model);
      }
      return;
    }
    if (obj.type === 'compacted') {
      session.events.push({ kind: 'meta', ts, text: 'context compacted' });
      touch(session, ts);
      return;
    }
    if (obj.type === 'event_msg') {
      if (type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        const current = {
          input: tokenCount(u.input_tokens),
          output: tokenCount(u.output_tokens),
          cacheRead: tokenCount(u.cached_input_tokens),
          cacheWrite: tokenCount(u.cache_creation_input_tokens),
        };
        const reset = Object.keys(current).some((key) => current[key] < previousUsage[key]);
        const delta = Object.fromEntries(
          Object.entries(current).map(([key, value]) => [key, reset ? value : value - previousUsage[key]]),
        );
        if (Object.values(delta).some((value) => value > 0)) {
          appendUsage(session, {
            ...delta,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
          }, ts, currentModel ?? session.model);
        }
        previousUsage = current;
      }
      return; // messages/tool activity are taken from response_item lines
    }
    if (obj.type !== 'response_item' && obj.type !== undefined && !p.role && !type) return;

    if (type === 'message') {
      const text = blocksOf(p.content).map((b) => b.text ?? '').filter(Boolean).join('\n');
      if (!text) return;
      touch(session, ts);
      const injected = isInjectedMetadataText(text);
      if (p.role === 'user' && !injected) {
        session.stats.messages++;
        session.events.push({ kind: 'user', ts, text });
        if (!session.label) session.label = text.slice(0, 100);
      } else if (p.role === 'assistant') {
        session.stats.messages++;
        session.events.push({ kind: 'assistant', ts, text });
      }
    } else if (type === 'reasoning') {
      const text = blocksOf(p.summary).map((b) => b.text ?? '').filter(Boolean).join('\n');
      if (text) {
        touch(session, ts);
        session.events.push({ kind: 'thinking', ts, text });
      }
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      let args = p.arguments ?? p.input ?? {};
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { input: args }; } }
      touch(session, ts);
      addToolCall(session, pending, ts, { id: p.call_id ?? p.id, name: p.name ?? 'tool', args });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const out = codexOutput(p.output ?? '');
      touch(session, ts);
      attachResult(session, pending, p.call_id ?? p.id, out.text, out.isError, ts, rowDiagnostics);
    } else if (type === 'web_search_call') {
      touch(session, ts);
      addToolCall(session, pending, ts, { id: p.id, name: 'web_search', args: p.action ?? {} });
    }
  });
  finalizeLabel(session);
  return { sessions: session.events.length ? [session] : [], diagnostics };
}

function codexAdapter(maxBytes) {
  const root = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'sessions');
  return {
    source: 'codex',
    *findFiles() {
      for (const file of walkJsonl(root, 4)) yield { file, agent: 'codex', root };
    },
    parseFile: ({ file }) => parseCodexFile(file, maxBytes),
  };
}

// ── Cursor (~/.cursor/projects/<project>/agent-transcripts/<session>) ───────
const CURSOR_CLI_TOOL_NAMES = {
  edit: 'Edit',
  read: 'Read',
  runTerminalCommand: 'Shell',
  search: 'Grep',
  shell: 'Shell',
  write: 'Write',
};

function cursorCliTool(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return { name: 'tool', args: {}, result: null };
  const entry = Object.entries(toolCall).find(([key]) => key.endsWith('ToolCall'));
  if (!entry) return { name: 'tool', args: {}, result: toolCall.result ?? null };
  const [key, value] = entry;
  const rawName = key.replace(/ToolCall$/, '');
  const name = CURSOR_CLI_TOOL_NAMES[rawName]
    ?? `${rawName.slice(0, 1).toUpperCase()}${rawName.slice(1)}`;
  return {
    name,
    args: value?.args ?? value?.input ?? {},
    result: value?.result ?? null,
  };
}

function cursorToolResult(value) {
  if (value == null) return { text: '', isError: false };
  const failure = value?.error ?? value?.failure;
  const success = value?.success;
  const selected = failure ?? success ?? value;
  return {
    text: typeof selected === 'string' ? selected : JSON.stringify(selected),
    isError: failure != null || value?.is_error === true || value?.isError === true,
  };
}

function cursorNativeTool(block) {
  const input = block?.input && typeof block.input === 'object' ? block.input : {};
  if (block?.name === 'CallDynamicTool' && typeof input.toolName === 'string') {
    return {
      name: input.toolName,
      args: input.arguments && typeof input.arguments === 'object' ? input.arguments : input,
    };
  }
  return { name: block?.name ?? 'tool', args: input };
}

/**
 * Parse both Cursor's native local agent transcript records and the documented
 * Cursor CLI stream-json event format. Native records do not carry timestamps,
 * so their file modification time is used as coarse activity attribution.
 */
export function parseCursorFile(file, agent = 'cursor', {
  fallbackTimestamp = fileModifiedTimestamp(file),
  linkScope = path.dirname(file),
  maxBytes = maxTranscriptBytes(),
} = {}) {
  const session = newSession('cursor', file, agent);
  const fileId = path.basename(file).replace(/\.(?:jsonl|ndjson)$/i, '');
  const pending = new Map();
  let nativeTurnTools = [];
  let assistantDelta = null;

  assignSessionId(session, fileId, {
    invalidSessionIds: 0,
  });
  session.linkScope = linkScope;
  if (path.basename(path.dirname(file)) === 'subagents') {
    session.intrinsicParent = path.basename(path.dirname(path.dirname(file)));
  }

  const flushAssistantDelta = () => {
    if (!assistantDelta?.text) {
      assistantDelta = null;
      return;
    }
    session.stats.messages++;
    session.events.push({
      kind: 'assistant',
      ts: assistantDelta.ts,
      text: assistantDelta.text,
    });
    assistantDelta = null;
  };

  const { diagnostics } = readJsonLines(file, maxBytes, (obj, rowDiagnostics) => {
    const ts = normalizedTimestamp(
      obj.timestamp ?? obj.created_at ?? obj.createdAt ?? fallbackTimestamp,
    );

    // Native Cursor IDE agent transcript record.
    if ((obj.role === 'user' || obj.role === 'assistant') && Array.isArray(obj.message?.content)) {
      const role = obj.role;
      const text = obj.message.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .filter(Boolean)
        .join('\n');
      touch(session, ts);
      flushAssistantDelta();
      if (role === 'user') {
        nativeTurnTools = [];
        if (text && !isInjectedMetadataText(text)) {
          session.stats.messages++;
          session.events.push({ kind: 'user', ts, text });
          if (!session.label) session.label = text.slice(0, 100);
        }
      } else {
        session.stats.messages++;
        if (text) session.events.push({ kind: 'assistant', ts, text });
        for (const block of obj.message.content.filter((item) => item?.type === 'tool_use')) {
          const tool = cursorNativeTool(block);
          const event = addToolCall(session, pending, ts, {
            id: block.id ?? null,
            name: tool.name,
            args: tool.args,
          });
          nativeTurnTools.push(event);
        }
      }
      return;
    }

    if (obj.type === 'turn_ended') {
      touch(session, ts);
      flushAssistantDelta();
      if (obj.status === 'error' || obj.error != null) {
        session.stats.errors++;
        session.events.push({
          kind: 'meta',
          ts,
          text: typeof obj.error === 'string' ? obj.error : 'Cursor turn failed',
        });
      } else if (obj.status === 'success') {
        for (const event of nativeTurnTools) event.tool.confirmed = true;
      }
      nativeTurnTools = [];
      return;
    }

    // Cursor CLI --output-format stream-json record.
    if (obj.type === 'system' && obj.subtype === 'init') {
      touch(session, ts);
      flushAssistantDelta();
      if (Object.hasOwn(obj, 'session_id')) assignSessionId(session, obj.session_id, rowDiagnostics);
      if (typeof obj.cwd === 'string') {
        session.cwd = obj.cwd;
        session.agent = path.basename(obj.cwd) || agent;
      }
      assignSessionModel(session, obj.model);
      return;
    }
    if (obj.type === 'user') {
      if (!obj.message || typeof obj.message !== 'object' || Array.isArray(obj.message)) {
        throw new TypeError('Cursor user message must be an object');
      }
      const text = textOf(obj.message?.content);
      touch(session, ts);
      flushAssistantDelta();
      if (text && !isInjectedMetadataText(text)) {
        session.stats.messages++;
        session.events.push({ kind: 'user', ts, text });
        if (!session.label) session.label = text.slice(0, 100);
      }
      return;
    }
    if (obj.type === 'assistant') {
      if (!obj.message || typeof obj.message !== 'object' || Array.isArray(obj.message)) {
        throw new TypeError('Cursor assistant message must be an object');
      }
      const text = textOf(obj.message?.content);
      touch(session, ts);
      if (text) {
        if (!assistantDelta) assistantDelta = { ts, text: '' };
        assistantDelta.text += text;
      }
      return;
    }
    if (obj.type === 'tool_call') {
      const call = cursorCliTool(obj.tool_call);
      const callId = obj.call_id ?? obj.tool_call_id ?? null;
      const completedResult = obj.subtype === 'completed'
        || obj.subtype === 'failed'
        || call.result != null
        ? cursorToolResult(call.result ?? obj.result)
        : null;
      touch(session, ts);
      flushAssistantDelta();
      let event = callId ? pending.get(callId) : null;
      if (!event) {
        event = addToolCall(session, pending, ts, {
          id: callId,
          name: call.name,
          args: call.args,
        });
      }
      if (completedResult) {
        attachResult(
          session,
          pending,
          callId,
          completedResult.text,
          completedResult.isError || obj.subtype === 'failed',
          ts,
          rowDiagnostics,
          event,
        );
      }
      return;
    }
    if (obj.type === 'result') {
      touch(session, ts);
      flushAssistantDelta();
      if (obj.is_error === true || obj.subtype === 'error') session.stats.errors++;
      assignSessionModel(session, obj.model);
    }
  });
  flushAssistantDelta();
  finalizeLabel(session);
  return { sessions: session.events.length ? [session] : [], diagnostics };
}

function cursorAdapter(maxBytes) {
  const root = path.resolve(process.env.CURSOR_STATE_DIR ?? path.join(os.homedir(), '.cursor'));
  const projectsRoot = fs.existsSync(path.join(root, 'projects')) ? path.join(root, 'projects') : root;
  return {
    source: 'cursor',
    *findFiles() {
      const directTranscripts = safeChildPath(projectsRoot, projectsRoot, 'agent-transcripts');
      const projectDirectories = directTranscripts && fs.existsSync(directTranscripts)
        ? [{ agent: path.basename(projectsRoot), directory: projectsRoot }]
        : safeReaddir(projectsRoot, projectsRoot)
          .map((agent) => ({
            agent,
            directory: safeChildPath(projectsRoot, projectsRoot, agent),
          }))
          .filter((project) => project.directory);
      const newestGroupById = new Map();
      for (const project of projectDirectories) {
        const transcripts = safeChildPath(projectsRoot, project.directory, 'agent-transcripts');
        if (!transcripts) continue;
        for (const id of safeReaddir(projectsRoot, transcripts)) {
          const group = safeChildPath(projectsRoot, transcripts, id);
          if (!group) continue;
          let stat;
          try {
            stat = fs.lstatSync(group);
          } catch {
            continue;
          }
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          const mainFile = safeChildPath(projectsRoot, group, `${id}.jsonl`);
          let modified = stat.mtimeMs;
          try {
            if (mainFile) modified = fs.lstatSync(mainFile).mtimeMs;
          } catch { /* use directory time */ }
          const existing = newestGroupById.get(id);
          if (!existing || modified > existing.modified) {
            newestGroupById.set(id, {
              agent: project.agent,
              group,
              modified,
            });
          }
        }
      }
      for (const { agent, group } of [...newestGroupById.values()].sort((a, b) => a.group.localeCompare(b.group))) {
        for (const file of walkJsonl(group, 2, projectsRoot)) {
          yield { file, agent, root, linkScope: group };
        }
      }
    },
    parseFile: ({ file, agent, linkScope }) => parseCursorFile(file, agent, { linkScope, maxBytes }),
  };
}

// ── Gemini CLI (~/.gemini/tmp/<project_hash>/chats) ─────────────────────────
const GEMINI_TOOL_NAMES = {
  glob: 'Glob',
  grep_search: 'Grep',
  list_directory: 'Read',
  read_file: 'Read',
  read_many_files: 'Read',
  replace: 'Edit',
  run_shell_command: 'Bash',
  write_file: 'Write',
};

function geminiToolName(value) {
  const name = typeof value === 'string' && value ? value : 'tool';
  return GEMINI_TOOL_NAMES[name] ?? name;
}

function geminiContent(value) {
  const text = textOf(value);
  if (text) return text;
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return ''; }
}

function geminiTokens(value) {
  if (!value || typeof value !== 'object') return null;
  const input = tokenCount(value.input_tokens ?? value.input);
  const output = tokenCount(value.output_tokens ?? value.output);
  const cacheRead = tokenCount(value.cached ?? value.cache_read_input_tokens);
  if (input === 0 && output === 0 && cacheRead === 0) return null;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  };
}

function geminiThoughtText(thought) {
  if (typeof thought === 'string') return thought;
  if (!thought || typeof thought !== 'object') return '';
  return [thought.subject, thought.description, thought.text]
    .filter((value) => typeof value === 'string' && value)
    .join('\n');
}

function parseGeminiMessages(session, messages, diagnostics) {
  const pending = new Map();
  for (const message of messages) {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        diagnostics.invalidRows++;
        continue;
      }
      if (!['user', 'gemini', 'error', 'warning', 'info'].includes(message.type)) continue;
      const ts = normalizedTimestamp(message.timestamp);
      const text = geminiContent(message.content);
      const thoughts = message.type === 'gemini'
        ? message.thoughts == null
          ? []
          : Array.isArray(message.thoughts)
            ? message.thoughts
            : (() => { throw new TypeError('Gemini thoughts must be an array'); })()
        : [];
      const calls = message.type === 'gemini'
        ? message.toolCalls == null
          ? []
          : Array.isArray(message.toolCalls)
            ? message.toolCalls
            : (() => { throw new TypeError('Gemini toolCalls must be an array'); })()
        : [];
      const preparedCalls = calls.map((call) => {
        if (!call || typeof call !== 'object' || Array.isArray(call)) {
          throw new TypeError('Gemini tool call must be an object');
        }
        const status = typeof call.status === 'string' ? call.status.toLowerCase() : '';
        const isError = status === 'error' || status === 'cancelled';
        return {
          call,
          status,
          isError,
          resultText: call.result != null
            ? geminiContent(call.result)
            : isError ? status : '',
        };
      });
      touch(session, ts);
      if (message.type === 'user') {
        if (text && !isInjectedMetadataText(text)) {
          session.stats.messages++;
          session.events.push({ kind: 'user', ts, text });
          if (!session.label) session.label = text.slice(0, 100);
        }
        continue;
      }
      if (message.type === 'gemini') {
        session.stats.messages++;
        const messageModel = assignSessionModel(session, message.model);
        if (text) session.events.push({ kind: 'assistant', ts, text });
        const tokens = geminiTokens(message.tokens);
        if (tokens) appendUsage(session, tokens, ts, messageModel ?? session.model);
        for (const thought of thoughts) {
          const thoughtText = geminiThoughtText(thought);
          if (thoughtText) {
            session.events.push({
              kind: 'thinking',
              ts: normalizedTimestamp(thought.timestamp) ?? ts,
              text: thoughtText,
            });
          }
        }
        for (const { call, status, isError, resultText } of preparedCalls) {
          const callTs = call.timestamp ?? ts;
          const event = addToolCall(session, pending, callTs, {
            id: call.id ?? null,
            name: geminiToolName(call.name),
            args: call.args ?? {},
          });
          if (resultText || isError) {
            attachResult(
              session,
              pending,
              call.id ?? null,
              resultText,
              isError,
              callTs,
              diagnostics,
              event,
            );
          } else if (status === 'success') {
            event.tool.confirmed = true;
          }
        }
        continue;
      }
      if (message.type === 'error') session.stats.errors++;
      if (text) {
        session.events.push({ kind: 'meta', ts, text });
      }
    } catch {
      diagnostics.rowErrors++;
    }
  }
}

/**
 * Parse Gemini CLI auto-saved chat JSONL/legacy JSON and its documented
 * non-interactive stream-json events into the shared trajectory model.
 */
export function parseGeminiFile(file, agent = 'gemini', {
  linkScope = path.dirname(file),
  intrinsicParent = null,
  maxBytes = maxTranscriptBytes(),
} = {}) {
  const session = newSession('gemini', file, agent);
  session.linkScope = linkScope;
  session.intrinsicParent = intrinsicParent;
  const messages = new Map();
  const pending = new Map();
  let assistantDelta = null;
  let metadata = {};
  let sawStreamEvent = false;
  let recordedStreamUsage = false;

  const flushAssistantDelta = () => {
    if (!assistantDelta?.text) {
      assistantDelta = null;
      return;
    }
    session.stats.messages++;
    session.events.push({ kind: 'assistant', ts: assistantDelta.ts, text: assistantDelta.text });
    assistantDelta = null;
  };

  const storeMessage = (message) => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string') return;
    messages.set(message.id, message);
  };

  const readRecords = path.extname(file).toLowerCase() === '.json'
    ? readJsonDocument
    : readJsonLines;
  const { diagnostics } = readRecords(file, maxBytes, (obj, rowDiagnostics) => {
    if (typeof obj.type === 'string' && ['init', 'message', 'tool_use', 'tool_result', 'error', 'result'].includes(obj.type)) {
      const ts = normalizedTimestamp(obj.timestamp);
      if (obj.type === 'message' && obj.content != null && typeof obj.content !== 'string') {
        throw new TypeError('Gemini stream message content must be a string');
      }
      sawStreamEvent = true;
      touch(session, ts);
      if (obj.type === 'init') {
        flushAssistantDelta();
        if (Object.hasOwn(obj, 'session_id')) assignSessionId(session, obj.session_id, rowDiagnostics);
        assignSessionModel(session, obj.model);
        return;
      }
      if (obj.type === 'message') {
        if (obj.role === 'assistant' && obj.delta === true) {
          if (!assistantDelta) assistantDelta = { ts, text: '' };
          assistantDelta.text += String(obj.content ?? '');
          return;
        }
        flushAssistantDelta();
        const text = String(obj.content ?? '');
        if (obj.role === 'user' && text && !isInjectedMetadataText(text)) {
          session.stats.messages++;
          session.events.push({ kind: 'user', ts, text });
          if (!session.label) session.label = text.slice(0, 100);
        } else if (obj.role === 'assistant' && text) {
          session.stats.messages++;
          session.events.push({ kind: 'assistant', ts, text });
        }
        return;
      }
      if (obj.type === 'tool_use') {
        flushAssistantDelta();
        addToolCall(session, pending, ts, {
          id: obj.tool_id ?? null,
          name: geminiToolName(obj.tool_name),
          args: obj.parameters ?? {},
        });
        return;
      }
      if (obj.type === 'tool_result') {
        flushAssistantDelta();
        const isError = obj.status === 'error' || obj.error != null;
        attachResult(
          session,
          pending,
          obj.tool_id ?? null,
          obj.output ?? obj.error?.message ?? '',
          isError,
          ts,
          rowDiagnostics,
        );
        return;
      }
      if (obj.type === 'error') {
        flushAssistantDelta();
        if (obj.severity === 'error') session.stats.errors++;
        if (typeof obj.message === 'string' && obj.message) {
          session.events.push({ kind: 'meta', ts, text: obj.message });
        }
        return;
      }
      if (obj.type === 'result') {
        flushAssistantDelta();
        if (obj.status === 'error') session.stats.errors++;
        const modelRows = Object.entries(obj.stats?.models ?? {});
        if (modelRows.length) {
          for (const [model, value] of modelRows) {
            const tokens = geminiTokens(value);
            if (tokens) appendUsage(session, tokens, ts, model);
          }
          recordedStreamUsage = true;
        } else {
          const tokens = geminiTokens(obj.stats);
          if (tokens) {
            appendUsage(session, tokens, ts, session.model);
            recordedStreamUsage = true;
          }
        }
      }
      return;
    }

    if (typeof obj.$rewindTo === 'string') {
      let found = false;
      for (const id of [...messages.keys()]) {
        if (id === obj.$rewindTo) found = true;
        if (found) messages.delete(id);
      }
      if (!found) messages.clear();
      return;
    }
    if (obj.$set && typeof obj.$set === 'object') {
      metadata = { ...metadata, ...obj.$set };
      if (Array.isArray(obj.$set.messages)) {
        messages.clear();
        for (const message of obj.$set.messages) storeMessage(message);
      }
      return;
    }
    if (typeof obj.id === 'string') {
      storeMessage(obj);
      return;
    }
    if (typeof obj.sessionId === 'string' && typeof obj.projectHash === 'string') {
      metadata = { ...metadata, ...obj };
      if (Array.isArray(obj.messages)) {
        for (const message of obj.messages) storeMessage(message);
      }
    }
  });
  flushAssistantDelta();

  if (!sawStreamEvent) {
    if (Object.hasOwn(metadata, 'sessionId')) assignSessionId(session, metadata.sessionId, diagnostics);
    if (typeof metadata.summary === 'string') session.label = metadata.summary;
    const directories = Array.isArray(metadata.directories) ? metadata.directories : [];
    if (typeof directories[0] === 'string') session.cwd = directories[0];
    touch(session, metadata.startTime);
    touch(session, metadata.lastUpdated);
    parseGeminiMessages(session, [...messages.values()], diagnostics);
  } else if (!recordedStreamUsage && session.model == null) {
    session.model = null;
  }

  finalizeLabel(session);
  return { sessions: session.events.length ? [session] : [], diagnostics };
}

function geminiAdapter(maxBytes) {
  const root = path.resolve(
    process.env.GEMINI_STATE_DIR
    ?? path.join(process.env.GEMINI_CLI_HOME ?? os.homedir(), '.gemini'),
  );
  const tmpRoot = path.join(root, 'tmp');
  return {
    source: 'gemini',
    *findFiles() {
      for (const projectHash of safeReaddir(tmpRoot, tmpRoot)) {
        const projectRoot = safeChildPath(tmpRoot, tmpRoot, projectHash);
        const chatsRoot = projectRoot ? safeChildPath(tmpRoot, projectRoot, 'chats') : null;
        if (!chatsRoot) continue;
        for (const file of walkJsonTranscripts(chatsRoot, 2, tmpRoot)) {
          const relative = path.relative(chatsRoot, file).split(path.sep);
          const parentId = relative.length > 1 ? relative[0] : null;
          yield {
            file,
            agent: projectHash,
            root,
            linkScope: chatsRoot,
            intrinsicParent: parentId,
          };
        }
      }
    },
    parseFile: ({ file, agent, linkScope, intrinsicParent }) => parseGeminiFile(file, agent, {
      linkScope,
      intrinsicParent,
      maxBytes,
    }),
  };
}

// ── Opt-in API and local-model logs ─────────────────────────────────────────
const IMPORT_IDENTITY = {
  openai: { provider: 'openai', runtime: 'OpenAI API' },
  'openai-api': { provider: 'openai', runtime: 'OpenAI API' },
  anthropic: { provider: 'anthropic', runtime: 'Anthropic API' },
  'anthropic-api': { provider: 'anthropic', runtime: 'Anthropic API' },
  claude: { provider: 'anthropic', runtime: 'Anthropic API' },
  nvidia: { provider: 'nvidia', runtime: 'NVIDIA API' },
  nemotron: { provider: 'nvidia', runtime: 'NVIDIA API' },
  moonshot: { provider: 'moonshot', runtime: 'Moonshot API' },
  kimi: { provider: 'moonshot', runtime: 'Moonshot API' },
  zhipu: { provider: 'zhipu', runtime: 'Zhipu API' },
  glm: { provider: 'zhipu', runtime: 'Zhipu API' },
  alibaba: { provider: 'alibaba', runtime: 'Alibaba API' },
  qwen: { provider: 'alibaba', runtime: 'Alibaba API' },
  mistral: { provider: 'mistral', runtime: 'Mistral API' },
  ollama: { provider: 'local', runtime: 'Ollama' },
  lmstudio: { provider: 'local', runtime: 'LM Studio' },
  'lm-studio': { provider: 'local', runtime: 'LM Studio' },
  local: { provider: 'local', runtime: 'Local API' },
};

function importIdentity(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const key = value.trim().toLowerCase().replaceAll('_', '-');
  return IMPORT_IDENTITY[key] ?? null;
}

function firstImportId(...values) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function assignImportedSessionId(session, runtime, rawId, diagnostics) {
  const candidate = `${runtime}:${rawId}`;
  if (assignSessionId(session, candidate, diagnostics)) return;
  const digest = crypto.createHash('sha256').update(String(rawId)).digest('hex').slice(0, 32);
  session.id = `${runtime}:import-${digest}`;
}

function importedTimestamp(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    if (typeof value === 'string' && value.length > 128) continue;
    const numeric = Number(value);
    const ms = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))
      ? numeric * (numeric > 10_000_000_000 ? 1 : 1000)
      : Date.parse(value);
    if (!Number.isFinite(ms)) continue;
    const date = new Date(ms);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return null;
}

function importedText(value, depth = 0) {
  if (depth > 32) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => importedText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (!value || typeof value !== 'object') return '';
  return importedText(
    value.text
    ?? value.content
    ?? value.output_text
    ?? value.input_text
    ?? value.thinking
    ?? value.summary
    ?? '',
    depth + 1,
  );
}

function importedArgs(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw: value };
  }
}

function addImportedUser(session, content, ts) {
  const text = importedText(content);
  if (!text || isInjectedMetadataText(text)) return;
  session.stats.messages++;
  session.events.push({ kind: 'user', ts, text });
  session.label ||= text.slice(0, 100);
  touch(session, ts);
}

function importedMessages(request) {
  const body = request?.body ?? request;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.messages)) return body.messages;
  if (Array.isArray(body.input)) return body.input;
  if (typeof body.input === 'string') return [{ role: 'user', content: body.input }];
  return [];
}

function validateImportedRow(identity, request, response) {
  const validateToolCalls = (value, label) => {
    if (value == null) return;
    if (
      !Array.isArray(value)
      || value.some((call) => !call || typeof call !== 'object' || Array.isArray(call))
    ) {
      throw new TypeError(`${label} tool calls must be an array of objects`);
    }
  };
  for (const message of importedMessages(request)) {
    if (message?.content != null) blocksOf(message.content);
  }
  const responseMessage = response?.choices?.[0]?.message;
  validateToolCalls(responseMessage?.tool_calls, 'OpenAI-compatible');
  if (identity.runtime === 'Ollama') {
    validateToolCalls(response?.message?.tool_calls, 'Ollama');
    return;
  }
  if (identity.runtime === 'LM Studio') {
    if (response?.output != null && !Array.isArray(response.output)) {
      throw new TypeError('LM Studio output must be an array');
    }
    if (response?.type === 'message') blocksOf(response.content);
    return;
  }
  if (identity.provider === 'anthropic') {
    blocksOf(response?.content);
    return;
  }
  if (response?.output != null && !Array.isArray(response.output)) {
    throw new TypeError('OpenAI-compatible output must be an array');
  }
}

function lastMessageIndex(messages, role) {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === role) return index;
  }
  return -1;
}

function addImportedRequest(session, pending, request, ts, diagnostics) {
  const messages = importedMessages(request);
  if (!messages.length) return;

  const lastAssistant = lastMessageIndex(messages, 'assistant');
  const lastUser = lastMessageIndex(messages, 'user');
  if (lastUser > lastAssistant) {
    const message = messages[lastUser];
    const blocks = blocksOf(message.content);
    for (const block of blocks) {
      if (block?.type === 'tool_result' || block?.type === 'toolResult') {
        attachResult(
          session,
          pending,
          block.tool_use_id ?? block.toolCallId,
          importedText(block.content),
          block.is_error ?? block.isError,
          ts,
          diagnostics,
        );
      }
    }
    const text = blocks
      .filter((block) => !['tool_result', 'toolResult'].includes(block?.type))
      .map((block) => importedText(block))
      .filter(Boolean)
      .join('\n');
    addImportedUser(session, text, ts);
  }

  for (let index = messages.length - 1; index > lastAssistant; index--) {
    const message = messages[index];
    if (message?.role === 'tool') {
      attachResult(
        session,
        pending,
        message.tool_call_id ?? message.toolCallId ?? message.id,
        importedText(message.content),
        Boolean(message.is_error ?? message.isError),
        ts,
        diagnostics,
      );
    } else if (message?.type === 'function_call_output') {
      attachResult(
        session,
        pending,
        message.call_id ?? message.id,
        importedText(message.output),
        Boolean(message.is_error ?? message.isError),
        ts,
        diagnostics,
      );
    }
  }
}

function importedOpenAiUsage(session, response, ts, model) {
  const usage = response?.usage
    ?? ((response?.input_tokens != null || response?.output_tokens != null) ? response : null);
  if (!usage) return;
  const input = tokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const output = tokenCount(usage.output_tokens ?? usage.completion_tokens);
  const cacheRead = tokenCount(
    usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_cached_tokens,
  );
  appendUsage(session, {
    input,
    output,
    cacheRead: Math.min(input, cacheRead),
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  }, ts, model);
}

function importedOpenAiResponse(session, pending, response, ts) {
  if (!response || typeof response !== 'object') return;
  const model = assignSessionModel(session, response.model) ?? session.model;
  const assistant = [];
  const thoughts = [];
  const toolCalls = [];
  const message = response.choices?.[0]?.message;
  if (message) {
    const text = importedText(message.content);
    if (text) assistant.push(text);
    const thinking = importedText(message.reasoning_content);
    if (thinking) thoughts.push(thinking);
    for (const call of message.tool_calls ?? []) {
      toolCalls.push({
        id: call?.id,
        name: call?.function?.name ?? call?.name ?? 'tool',
        args: importedArgs(call?.function?.arguments ?? call?.arguments),
      });
    }
  }
  for (const item of response.output ?? []) {
    if (item?.type === 'message') {
      const text = importedText(item.content);
      if (text) assistant.push(text);
    } else if (item?.type === 'reasoning') {
      const text = importedText(item.summary ?? item.content);
      if (text) thoughts.push(text);
    } else if (['function_call', 'custom_tool_call'].includes(item?.type)) {
      toolCalls.push({
        id: item.call_id ?? item.id,
        name: item.name ?? item.tool_name ?? item.type,
        args: importedArgs(item.arguments ?? item.input),
      });
    }
  }
  if (!assistant.length) {
    const text = importedText(response.output_text);
    if (text) assistant.push(text);
  }
  if (assistant.length || thoughts.length || toolCalls.length) session.stats.messages++;
  for (const text of thoughts) session.events.push({ kind: 'thinking', ts, text });
  if (assistant.length) session.events.push({ kind: 'assistant', ts, text: assistant.join('\n') });
  for (const call of toolCalls) addToolCall(session, pending, ts, call);
  importedOpenAiUsage(session, response, ts, model);
}

function importedAnthropicResponse(session, pending, response, ts, diagnostics) {
  if (!response || typeof response !== 'object') return;
  const blocks = blocksOf(response.content);
  assignSessionModel(session, response.model);
  session.stats.messages++;
  for (const block of blocks) {
    if (block?.type === 'text' && block.text) {
      session.events.push({ kind: 'assistant', ts, text: block.text });
    } else if (['thinking', 'redacted_thinking'].includes(block?.type)) {
      const text = importedText(block);
      if (text) session.events.push({ kind: 'thinking', ts, text });
    } else if (['tool_use', 'server_tool_use'].includes(block?.type)) {
      addToolCall(session, pending, ts, {
        id: block.id,
        name: block.name ?? 'tool',
        args: block.input ?? {},
      });
    } else if (block?.type?.endsWith('_tool_result') || block?.type === 'tool_result') {
      attachResult(
        session,
        pending,
        block.tool_use_id ?? block.id,
        importedText(block.content),
        Boolean(block.is_error),
        ts,
        diagnostics,
      );
    }
  }
  recordUsage(session, response.usage, ts, response.model ?? session.model);
}

function importedOllamaResponse(session, pending, response, ts, rowIndex) {
  if (!response || typeof response !== 'object') return;
  assignSessionModel(session, response.model);
  const message = response.message ?? {};
  const text = importedText(message.content);
  const thinking = importedText(message.thinking);
  session.stats.messages++;
  if (thinking) session.events.push({ kind: 'thinking', ts, text: thinking });
  if (text) session.events.push({ kind: 'assistant', ts, text });
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    addToolCall(session, pending, ts, {
      id: call?.id ?? `ollama-${rowIndex}-${index}`,
      name: call?.function?.name ?? call?.name ?? 'tool',
      args: call?.function?.arguments ?? call?.arguments ?? {},
    });
  }
  appendUsage(session, {
    input: tokenCount(response.prompt_eval_count),
    output: tokenCount(response.eval_count),
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  }, ts, response.model ?? session.model);
}

function importedLmStudioResponse(session, pending, response, ts, rowIndex) {
  if (!response || typeof response !== 'object') return;
  assignSessionModel(session, response.model_instance_id);
  const output = response.output ?? [];
  session.stats.messages++;
  for (const [index, item] of output.entries()) {
    if (item?.type === 'message') {
      const text = importedText(item.content);
      if (text) session.events.push({ kind: 'assistant', ts, text });
    } else if (item?.type === 'reasoning') {
      const text = importedText(item.content);
      if (text) session.events.push({ kind: 'thinking', ts, text });
    } else if (item?.type === 'tool_call') {
      const event = addToolCall(session, pending, ts, {
        id: item.id ?? `lm-studio-${rowIndex}-${index}`,
        name: item.tool ?? 'tool',
        args: item.arguments ?? {},
      });
      if (item.output != null) {
        event.tool.result = importedText(item.output);
        event.tool.resultTs = ts;
        event.tool.confirmed = true;
      }
    } else if (item?.type === 'invalid_tool_call') {
      const event = addToolCall(session, pending, ts, {
        id: item.id ?? `lm-studio-invalid-${rowIndex}-${index}`,
        name: item.metadata?.tool_name ?? 'invalid_tool_call',
        args: item.metadata?.arguments ?? {},
      });
      event.tool.result = importedText(item.reason) || 'Invalid tool call';
      event.tool.resultTs = ts;
      event.tool.isError = true;
      session.stats.errors++;
    }
  }
  const stats = response.stats;
  if (stats) {
    appendUsage(session, {
      input: tokenCount(stats.input_tokens),
      output: tokenCount(stats.total_output_tokens),
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }, ts, session.model);
  }
}

/**
 * Parse opt-in JSONL where each line wraps one captured API request/response:
 * { provider, timestamp?, session_id?, request?, response?, error? }.
 */
export function parseApiLogFile(file, agent = 'imports', maxBytes = maxTranscriptBytes()) {
  const sessions = new Map();
  const fallbackTs = fileModifiedTimestamp(file);
  let rowIndex = 0;
  const { diagnostics } = readJsonLines(file, maxBytes, (row, rowDiagnostics) => {
    rowIndex++;
    const identity = importIdentity(row?.provider ?? row?.platform ?? row?.runtime);
    if (!identity) return;
    const responseEnvelope = row.response?.body ?? row.response ?? row.result ?? null;
    const request = row.request?.body ?? row.request ?? null;
    const response = responseEnvelope ?? row;
    validateImportedRow(identity, request, response);
    const inferredSessionId = firstImportId(
      row.session_id,
      row.sessionId,
      row.conversation_id,
      row.conversationId,
      responseEnvelope?.response_id,
      responseEnvelope?.id,
      path.basename(file, path.extname(file)),
    );
    const groupDigest = crypto.createHash('sha256')
      .update(String(inferredSessionId))
      .digest('hex');
    const groupKey = `${identity.runtime}\0${groupDigest}`;
    let entry = sessions.get(groupKey);
    if (!entry) {
      const session = newSession('api-log', file, identity.runtime);
      assignImportedSessionId(session, identity.runtime, inferredSessionId, rowDiagnostics);
      session.provider = identity.provider;
      session.runtime = identity.runtime;
      session.cwd = typeof row.cwd === 'string' ? row.cwd : null;
      entry = { session, pending: new Map() };
      sessions.set(groupKey, entry);
    }
    const { session, pending } = entry;
    const model = assignSessionModel(
      session,
      request?.model ?? response?.model ?? response?.model_instance_id ?? row.model,
    );
    const ts = importedTimestamp(
      row.timestamp,
      row.ts,
      response?.created_at,
      response?.created,
      fallbackTs,
    );
    touch(session, ts);
    addImportedRequest(session, pending, request, ts, rowDiagnostics);

    if (identity.runtime === 'Ollama') {
      importedOllamaResponse(session, pending, response, ts, rowIndex);
    } else if (identity.runtime === 'LM Studio' && Array.isArray(response?.output) && response?.stats) {
      importedLmStudioResponse(session, pending, response, ts, rowIndex);
    } else if (
      identity.provider === 'anthropic'
      || (identity.runtime === 'LM Studio' && response?.type === 'message' && Array.isArray(response?.content))
    ) {
      importedAnthropicResponse(session, pending, response, ts, rowDiagnostics);
    } else {
      importedOpenAiResponse(session, pending, response, ts);
    }

    const rawStatusCode = row.status_code ?? row.response?.status_code;
    const statusCode = typeof rawStatusCode === 'string' || typeof rawStatusCode === 'number'
      ? Number(rawStatusCode)
      : Number.NaN;
    const error = row.error ?? response?.error;
    if (error || (Number.isFinite(statusCode) && statusCode >= 400)) {
      session.stats.errors++;
      session.events.push({
        kind: 'meta',
        ts,
        text: importedText(error?.message ?? error) || `API request failed (${statusCode})`,
      });
    }
    touch(session, ts);
  });

  const parsed = [];
  for (const { session } of sessions.values()) {
    finalizeLabel(session);
    if (session.events.length || session.usage.length) parsed.push(session);
  }
  return { sessions: parsed, diagnostics };
}

function apiLogAdapter(importDir, maxBytes) {
  const root = path.resolve(importDir);
  return {
    source: 'api-log',
    *findFiles() {
      for (const file of walkJsonl(root, 4)) {
        yield { file, agent: path.basename(path.dirname(file)), root };
      }
    },
    parseFile: ({ file, agent }) => parseApiLogFile(file, agent, maxBytes),
  };
}

// ── Hermes (best-effort generic: HERMES_STATE_DIR or ~/.hermes) ──────────────
function hermesAdapter(maxBytes, explicitRoot = null) {
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : process.env.HERMES_STATE_DIR ?? path.join(os.homedir(), '.hermes');
  return {
    source: 'hermes',
    *findFiles() {
      for (const file of walkJsonl(root, 4)) {
        yield { file, agent: path.basename(path.dirname(file)), root };
      }
    },
    parseFile: ({ file, agent }) => parseGenericAgentFile('hermes', file, agent, maxBytes),
  };
}

export function makeAdapters({
  hermesDir = null,
  importDir = null,
  sources = null,
  maxFileBytes = maxTranscriptBytes(),
} = {}) {
  const maxBytes = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0
    ? maxFileBytes
    : maxTranscriptBytes();
  const all = [
    claudeCodeAdapter(maxBytes),
    cursorAdapter(maxBytes),
    codexAdapter(maxBytes),
    geminiAdapter(maxBytes),
    ...(importDir ? [apiLogAdapter(importDir, maxBytes)] : []),
    hermesAdapter(maxBytes, hermesDir),
  ];
  return sources ? all.filter((a) => sources.includes(a.source)) : all;
}
