import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  newSession,
  isInjectedMetadataText,
  readJsonLines,
  readJsonDocument,
  maxTranscriptBytes,
  tokenCount,
  normalizedTimestamp,
  assignSessionModel,
  textOf,
  assignSessionId,
  appendUsage,
  addToolCall,
  attachResult,
  touch,
  finalizeLabel,
  safeReaddir,
  safeChildPath,
  walkJsonTranscripts,
} from './shared.mjs';

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

export {
  geminiAdapter,
};
