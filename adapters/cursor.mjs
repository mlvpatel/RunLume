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
import {
  parseClaudeCodeFile,
  CC_SKIP_TYPES,
  ccParseMessageInto,
  claudeCodeAdapter,
} from './claude.mjs';
import {
  parseCodexFile,
  codexOutput,
  codexAdapter,
} from './codex.mjs';
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

export {
  CURSOR_CLI_TOOL_NAMES,
  cursorCliTool,
  cursorToolResult,
  cursorNativeTool,
  cursorAdapter,
};
