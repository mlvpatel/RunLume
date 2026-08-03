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
import {
  parseCursorFile,
  CURSOR_CLI_TOOL_NAMES,
  cursorCliTool,
  cursorToolResult,
  cursorNativeTool,
  cursorAdapter,
} from './cursor.mjs';
import {
  parseGeminiFile,
  GEMINI_TOOL_NAMES,
  geminiToolName,
  geminiContent,
  geminiTokens,
  geminiThoughtText,
  parseGeminiMessages,
  geminiAdapter,
} from './gemini.mjs';
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

export {
  IMPORT_IDENTITY,
  importIdentity,
  firstImportId,
  assignImportedSessionId,
  importedTimestamp,
  importedText,
  importedArgs,
  addImportedUser,
  importedMessages,
  validateImportedRow,
  lastMessageIndex,
  addImportedRequest,
  importedOpenAiUsage,
  importedOpenAiResponse,
  importedAnthropicResponse,
  importedOllamaResponse,
  importedLmStudioResponse,
  apiLogAdapter,
};
