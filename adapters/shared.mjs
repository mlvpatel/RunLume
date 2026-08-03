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

export {
  SPAWN_TOOL_RE,
  addToolCall,
  appendUsage,
  assignSessionId,
  assignSessionModel,
  attachResult,
  blocksOf,
  fileModifiedTimestamp,
  finalizeLabel,
  maxTranscriptBytes,
  normalizedTimestamp,
  parseGenericMessage,
  recordUsage,
  safeChildPath,
  safeReaddir,
  textOf,
  tokenCount,
  touch,
  walkJsonTranscripts,
  walkJsonl,
};
