import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  newSession,
  isInjectedMetadataText,
  readJsonLines,
  maxTranscriptBytes,
  tokenCount,
  normalizedTimestamp,
  assignSessionModel,
  blocksOf,
  assignSessionId,
  appendUsage,
  addToolCall,
  attachResult,
  touch,
  finalizeLabel,
  walkJsonl,
} from './shared.mjs';

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

export {
  codexAdapter,
};
