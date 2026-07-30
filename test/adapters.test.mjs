import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeAdapters,
  parseClaudeCodeFile,
  parseCodexFile,
  parseCursorFile,
  parseGeminiFile,
  parseApiLogFile,
  parseGenericAgentFile,
  readJsonDocument,
  readJsonLines,
} from '../adapters.mjs';
import { buildStats } from '../analytics.mjs';

const CURSOR_FIXTURE = fileURLToPath(new URL('./fixtures/cursor/session.jsonl', import.meta.url));
const GEMINI_FIXTURE = fileURLToPath(new URL('./fixtures/gemini/session.jsonl', import.meta.url));
const HERMES_FIXTURE = fileURLToPath(new URL('./fixtures/hermes/session.jsonl', import.meta.url));
const API_LOG_FIXTURE = fileURLToPath(new URL('./fixtures/api-log/session.jsonl', import.meta.url));

function fixture(t, name, rows, malformed = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-adapter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(file, `${body}${malformed ? '\n{broken' : ''}\n`);
  return file;
}

test('JSON readers isolate callback failures to one record', (t) => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const jsonl = fixture(t, 'callback-errors.jsonl', rows);
  const jsonlSeen = [];
  const lineResult = readJsonLines(jsonl, undefined, (row) => {
    jsonlSeen.push(row.id);
    if (row.id === 2) throw new Error('sentinel local path must not escape diagnostics');
  });
  assert.deepEqual(jsonlSeen, [1, 2, 3]);
  assert.equal(lineResult.diagnostics.rowErrors, 1);
  assert.equal(lineResult.diagnostics.readError, null);

  const document = fixture(t, 'callback-errors.json', []);
  fs.writeFileSync(document, JSON.stringify(rows));
  const documentSeen = [];
  const documentResult = readJsonDocument(document, undefined, (row) => {
    documentSeen.push(row.id);
    if (row.id === 2) throw new Error('sentinel local path must not escape diagnostics');
  });
  assert.deepEqual(documentSeen, [1, 2, 3]);
  assert.equal(documentResult.diagnostics.rowErrors, 1);
  assert.equal(documentResult.diagnostics.readError, null);
});

test('transcript cwd fields must be non-empty strings', (t) => {
  const generic = fixture(t, 'invalid-generic-cwd.jsonl', [
    { type: 'session', id: 'generic-cwd', cwd: { path: '/private' }, timestamp: '2026-07-20T10:00:00Z' },
    { role: 'user', content: 'Continue', timestamp: '2026-07-20T10:00:01Z' },
  ]);
  assert.equal(parseGenericAgentFile('hermes', generic, 'main').sessions[0].cwd, null);

  const claude = fixture(t, 'invalid-claude-cwd.jsonl', [
    { type: 'user', uuid: 'user-1', cwd: ['private'], timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'Continue' } },
  ]);
  assert.equal(parseClaudeCodeFile(claude, 'project').sessions[0].cwd, null);

  const codex = fixture(t, 'invalid-codex-cwd.jsonl', [
    { type: 'session_meta', timestamp: '2026-07-20T10:00:00Z', payload: { id: 'codex-cwd', cwd: 42 } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] } },
  ]);
  assert.equal(parseCodexFile(codex).sessions[0].cwd, null);
});

test('generic agent parser reports malformed lines and links structured tool errors', (t) => {
  const file = fixture(t, 'generic-agent.jsonl', [
    { type: 'session', id: 'session-a', cwd: '/workspace/project', timestamp: '2026-07-20T10:00:00Z' },
    { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Run it' }] } },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:02Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: { input: 10, output: 2 },
        content: [{ type: 'toolCall', id: 'call-1', name: 'exec', arguments: { command: 'false' } }],
      },
    },
    { type: 'message', timestamp: '2026-07-20T10:00:03Z', message: { role: 'toolResult', toolCallId: 'call-1', isError: true, content: 'failed' } },
  ], true);

  const result = parseGenericAgentFile('hermes', file, 'main');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].cwd, '/workspace/project');
  assert.equal(result.sessions[0].stats.errors, 1);
  assert.equal(result.sessions[0].events.find((event) => event.kind === 'tool').tool.isError, true);
  assert.equal(result.diagnostics.malformedLines, 1);
});

test('valid JSON primitives are skipped without aborting later transcript rows', (t) => {
  const file = fixture(t, 'primitive-row.jsonl', [
    { type: 'session', id: 'primitive-row', timestamp: '2026-07-20T10:00:00Z' },
    null,
    { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'user', content: 'Still parsed' } },
  ]);
  const result = parseGenericAgentFile('hermes', file, 'main');
  assert.equal(result.diagnostics.invalidRows, 1);
  assert.equal(result.diagnostics.readError, null);
  assert.equal(result.sessions[0].label, 'Still parsed');
});

test('invalid message rows cannot mutate later generic session activity', (t) => {
  const file = fixture(t, 'transactional-generic-row.jsonl', [
    { type: 'session', id: 'transactional-row', timestamp: '2026-07-20T10:00:00Z' },
    {
      type: 'message',
      timestamp: '2100-01-01T00:00:00Z',
      message: { role: 'assistant', content: [null] },
    },
    { type: 'message', timestamp: '2100-01-02T00:00:00Z', message: 'invalid envelope' },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:02Z',
      message: { role: 'user', content: 'Still parsed' },
    },
  ]);
  const result = parseGenericAgentFile('hermes', file, 'main');
  assert.equal(result.diagnostics.rowErrors, 2);
  assert.equal(result.sessions.length, 1);
  assert.equal(
    Date.parse(result.sessions[0].endedAt),
    Date.parse('2026-07-20T10:00:02Z'),
  );
  assert.equal(result.sessions[0].stats.messages, 1);
  assert.deepEqual(result.sessions[0].events.map((event) => event.text), ['Still parsed']);
});

test('malformed future rows cannot mutate Codex, Cursor, or Gemini activity', (t) => {
  const codexId = '11111111-1111-4111-8111-111111111111';
  const codexFile = fixture(t, `rollout-${codexId}.jsonl`, [
    {
      type: 'session_meta',
      timestamp: '2026-07-20T10:00:00Z',
      payload: { id: codexId, cwd: '/workspace/project' },
    },
    {
      type: 'response_item',
      timestamp: '2100-01-01T00:00:00Z',
      payload: { type: 'message', role: 'assistant', content: [null] },
    },
    {
      type: 'response_item',
      timestamp: '2026-07-20T10:00:02Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex survives' }] },
    },
  ]);
  const codex = parseCodexFile(codexFile);
  assert.equal(codex.diagnostics.rowErrors, 1);
  assert.equal(codex.sessions[0].endedAt, '2026-07-20T10:00:02Z');

  const cursorFile = fixture(t, 'cursor-transactional.jsonl', [
    {
      type: 'system',
      subtype: 'init',
      timestamp: '2026-07-20T10:00:00Z',
      session_id: 'cursor-transactional',
    },
    {
      type: 'user',
      timestamp: '2100-01-01T00:00:00Z',
      message: { role: 'user', content: [null] },
    },
    {
      type: 'user',
      timestamp: '2026-07-20T10:00:02Z',
      message: { role: 'user', content: 'Cursor survives' },
    },
  ]);
  const cursor = parseCursorFile(cursorFile);
  assert.equal(cursor.diagnostics.rowErrors, 1);
  assert.equal(cursor.sessions[0].endedAt, '2026-07-20T10:00:02Z');

  const geminiFile = fixture(t, 'gemini-transactional.json', []);
  fs.writeFileSync(geminiFile, JSON.stringify({
    sessionId: 'gemini-transactional',
    projectHash: 'project',
    messages: [
      {
        id: 'bad',
        type: 'gemini',
        timestamp: '2100-01-01T00:00:00Z',
        content: [null],
      },
      {
        id: 'good',
        type: 'user',
        timestamp: '2026-07-20T10:00:02Z',
        content: 'Gemini survives',
      },
    ],
  }));
  const gemini = parseGeminiFile(geminiFile);
  assert.equal(gemini.diagnostics.rowErrors, 1);
  assert.equal(gemini.sessions[0].endedAt, '2026-07-20T10:00:02Z');
});

test('generic agent parser records per-turn model usage and cache-write tiers', (t) => {
  const file = fixture(t, 'generic-usage.jsonl', [
    { type: 'session', id: 'usage-session', timestamp: '2026-07-20T10:00:00Z' },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
          cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 },
        },
        content: 'First',
      },
    },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:02Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 20, output_tokens: 4 },
        content: 'Second',
      },
    },
  ]);

  const session = parseGenericAgentFile('hermes', file, 'main').sessions[0];
  assert.equal(session.usage.length, 2);
  assert.deepEqual(session.usage.map((usage) => usage.model), ['claude-opus-4-8', 'claude-sonnet-4-6']);
  assert.equal(session.usage[0].input, 18);
  assert.equal(session.usage[0].cacheWrite5m, 2);
  assert.equal(session.usage[0].cacheWrite1h, 1);
  assert.equal(session.stats.tokensIn, 38);
});

test('usage counters coerce numeric strings and reject invalid or negative values', (t) => {
  const file = fixture(t, 'numeric-usage.jsonl', [
    { type: 'session', id: 'numeric-usage', timestamp: '2026-07-20T10:00:00Z' },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: '10',
          output_tokens: '2',
          cache_read_input_tokens: '5',
          cache_creation_input_tokens: '3',
          cache_creation_5m_input_tokens: '-4',
          cache_creation_1h_input_tokens: 'not-a-number',
        },
        content: 'Done',
      },
    },
  ]);

  const session = parseGenericAgentFile('hermes', file, 'main').sessions[0];
  assert.equal(session.stats.tokensIn, 18);
  assert.equal(session.stats.tokensOut, 2);
  assert.equal(session.stats.tokensCacheRead, 5);
  assert.equal(session.stats.tokensCacheWrite, 3);
  assert.equal(typeof session.stats.tokensIn, 'number');
  assert.deepEqual(session.usage[0], {
    ts: '2026-07-20T10:00:01Z',
    model: 'claude-sonnet-4-6',
    input: 18,
    output: 2,
    cacheRead: 5,
    cacheWrite: 3,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
  });
});

test('tool and model identifiers are bounded and cannot corrupt counters', (t) => {
  const longName = `tool-${'x'.repeat(300)}`;
  const longModel = `model-${'y'.repeat(300)}`;
  const file = fixture(t, 'bounded-identifiers.jsonl', [
    { type: 'session', id: 'bounded-identifiers', timestamp: '2026-07-20T10:00:00Z' },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:01Z',
      message: {
        role: 'assistant',
        model: longModel,
        usage: { input_tokens: 10, output_tokens: 2 },
        content: [
          { type: 'toolCall', id: 'call-1', name: '__proto__', arguments: {} },
          { type: 'toolCall', id: 'call-2', name: 'constructor', arguments: {} },
          { type: 'toolCall', id: 'call-3', name: longName, arguments: {} },
        ],
      },
    },
  ]);

  const session = parseGenericAgentFile('hermes', file, 'main').sessions[0];
  assert.equal(Object.getPrototypeOf(session.stats.toolCounts), null);
  assert.equal(session.stats.toolCounts.__proto__, 1);
  assert.equal(session.stats.toolCounts.constructor, 1);
  assert.equal(Object.keys(session.stats.toolCounts).length, 3);
  assert.equal(session.events.at(-1).tool.name.length, 160);
  assert.equal(session.model.length, 160);
  assert.equal(session.usage[0].model.length, 160);
});

test('Claude Code parser creates intrinsic sidechain relationships', (t) => {
  const file = fixture(t, 'claude.jsonl', [
    {
      type: 'user',
      uuid: 'main-user',
      cwd: '/workspace/project',
      timestamp: '2026-07-20T10:00:00Z',
      message: { role: 'user', content: 'Build it' },
    },
    {
      type: 'assistant',
      uuid: 'main-assistant',
      timestamp: '2026-07-20T10:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: { prompt: 'Investigate the parser' } }],
      },
    },
    {
      type: 'user',
      uuid: 'side-user',
      parentUuid: 'task-1',
      isSidechain: true,
      timestamp: '2026-07-20T10:00:02Z',
      message: { role: 'user', content: 'Investigate the parser' },
    },
    {
      type: 'assistant',
      uuid: 'side-assistant',
      parentUuid: 'side-user',
      isSidechain: true,
      timestamp: '2026-07-20T10:00:03Z',
      message: { role: 'assistant', model: 'claude-opus-4-8', content: 'Done' },
    },
  ]);

  const result = parseClaudeCodeFile(file, 'project');
  assert.equal(result.sessions.length, 2);
  const [main, child] = result.sessions;
  assert.equal(child.intrinsicParent, main.id);
  assert.deepEqual(main.intrinsicChildren, [child.id]);
  assert.equal(main.events.find((event) => event.kind === 'tool').tool.intrinsicSpawnTarget, child.id);
});

test('Claude Code sidechain grouping is stack-safe and near-linear for deep chains', { timeout: 10_000 }, (t) => {
  const rows = [];
  for (let index = 0; index < 10_000; index++) {
    rows.push({
      type: index % 2 ? 'assistant' : 'user',
      uuid: `side-${String(index).padStart(5, '0')}`,
      ...(index ? { parentUuid: `side-${String(index - 1).padStart(5, '0')}` } : {}),
      isSidechain: true,
      timestamp: new Date(Date.parse('2026-07-20T10:00:00Z') + index).toISOString(),
      message: {
        role: index % 2 ? 'assistant' : 'user',
        content: index % 2 ? 'Done' : 'Continue',
      },
    });
  }
  const file = fixture(t, 'deep-claude-sidechain.jsonl', rows);
  const result = parseClaudeCodeFile(file, 'project');
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[1].events.length, 10_000);
  assert.equal(result.diagnostics.rowErrors, 0);
});

test('Claude Code sidechain cycles resolve to one deterministic chain', (t) => {
  const file = fixture(t, 'cyclic-claude-sidechain.jsonl', [
    { type: 'user', uuid: 'cycle-b', parentUuid: 'cycle-a', isSidechain: true, timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'First' } },
    { type: 'assistant', uuid: 'cycle-a', parentUuid: 'cycle-b', isSidechain: true, timestamp: '2026-07-20T10:00:01Z', message: { role: 'assistant', content: 'Second' } },
  ]);
  const result = parseClaudeCodeFile(file, 'project');
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(
    result.sessions[1].events.map((event) => event.text),
    ['First', 'Second'],
  );
});

test('UUID-less Claude sidechain rows inherit their known parent chain', (t) => {
  const file = fixture(t, 'uuidless-claude-sidechain.jsonl', [
    { type: 'user', uuid: 'root-sidechain', isSidechain: true, timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'First' } },
    { type: 'assistant', parentUuid: 'root-sidechain', isSidechain: true, timestamp: '2026-07-20T10:00:01Z', message: { role: 'assistant', content: 'Second' } },
  ]);
  const result = parseClaudeCodeFile(file, 'project');
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(
    result.sessions[1].events.map((event) => event.text),
    ['First', 'Second'],
  );
});

test('malformed deferred Claude sidechain rows do not abort or mutate the chain', (t) => {
  const file = fixture(t, 'malformed-claude-sidechain.jsonl', [
    {
      type: 'user',
      uuid: 'main-user',
      timestamp: '2026-07-20T10:00:00Z',
      message: { role: 'user', content: 'Main task' },
    },
    {
      type: 'user',
      uuid: 'side-user',
      isSidechain: true,
      timestamp: '2026-07-20T10:00:01Z',
      message: { role: 'user', content: 'First' },
    },
    {
      type: 'assistant',
      uuid: 'side-bad',
      parentUuid: 'side-user',
      isSidechain: true,
      timestamp: '2100-01-01T00:00:00Z',
      message: { role: 'assistant', content: [null] },
    },
    {
      type: 'assistant',
      uuid: 'side-good',
      parentUuid: 'side-bad',
      isSidechain: true,
      timestamp: '2026-07-20T10:00:02Z',
      message: { role: 'assistant', content: 'Last' },
    },
  ]);
  const result = parseClaudeCodeFile(file, 'project');
  assert.equal(result.diagnostics.rowErrors, 1);
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[1].endedAt, '2026-07-20T10:00:02Z');
  assert.deepEqual(result.sessions[1].events.map((event) => event.text), ['First', 'Last']);
});

test('malformed Claude task prompts and titles cannot abort sidechain linking', (t) => {
  const file = fixture(t, 'malformed-claude-link.jsonl', [
    { type: 'ai-title', aiTitle: { bad: true } },
    {
      type: 'user',
      uuid: 'main-user',
      timestamp: '2026-07-20T10:00:00Z',
      message: { role: 'user', content: 'Main task' },
    },
    {
      type: 'assistant',
      uuid: 'main-assistant',
      timestamp: '2026-07-20T10:00:01Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'task-bad-prompt',
          name: 'Task',
          input: { prompt: { bad: true } },
        }],
      },
    },
    {
      type: 'user',
      uuid: 'side-user',
      parentUuid: 'task-bad-prompt',
      isSidechain: true,
      timestamp: '2026-07-20T10:00:02Z',
      message: { role: 'user', content: 'Inspect safely' },
    },
    {
      type: 'assistant',
      uuid: 'side-assistant',
      parentUuid: 'side-user',
      isSidechain: true,
      timestamp: '2026-07-20T10:00:03Z',
      message: { role: 'assistant', content: 'Done' },
    },
  ]);

  const result = parseClaudeCodeFile(file, 'project');
  assert.equal(result.sessions.length, 2);
  assert.equal(result.sessions[0].label, 'Main task');
  assert.deepEqual(
    result.sessions[1].events.map((event) => event.text),
    ['Inspect safely', 'Done'],
  );
  assert.equal(
    result.sessions[0].events.find((event) => event.kind === 'tool').tool.spawnTarget,
    undefined,
  );
});

test('Codex parser uses structured exit codes and cumulative token counts', (t) => {
  const id = '2f21f7d0-20ad-43d8-9ef8-357436747e1d';
  const file = fixture(t, `rollout-test-${id}.jsonl`, [
    { type: 'session_meta', timestamp: '2026-07-20T10:00:00Z', payload: { id, cwd: '/workspace/project' } },
    { type: 'turn_context', timestamp: '2026-07-20T10:00:00Z', payload: { model: 'gpt-5.6-sol' } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Run it' }] } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:02Z', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'false' }) } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:03Z', payload: { type: 'function_call_output', call_id: 'call-1', output: JSON.stringify({ output: 'command failed', exit_code: 2 }) } },
    { type: 'event_msg', timestamp: '2026-07-20T10:00:04Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 } } } },
    { type: 'turn_context', timestamp: '2026-07-20T10:00:05Z', payload: { model: 'gpt-5.6-terra' } },
    { type: 'event_msg', timestamp: '2026-07-20T10:00:06Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, output_tokens: 30, cached_input_tokens: 50 } } } },
  ]);

  const result = parseCodexFile(file);
  const session = result.sessions[0];
  assert.equal(session.id, id);
  assert.equal(session.cwd, '/workspace/project');
  assert.equal(session.model, 'gpt-5.6-terra');
  assert.equal(session.stats.errors, 1);
  assert.equal(session.stats.tokensIn, 150);
  assert.equal(session.stats.tokensCacheRead, 50);
  assert.deepEqual(session.usage.map((usage) => usage.input), [100, 50]);
  assert.deepEqual(session.usage.map((usage) => usage.model), ['gpt-5.6-sol', 'gpt-5.6-terra']);
});

test('Cursor native transcript parser preserves messages, edits, and turn errors', () => {
  const timestamp = '2026-07-26T10:00:00.000Z';
  const result = parseCursorFile(CURSOR_FIXTURE, 'dashboard', {
    fallbackTimestamp: timestamp,
    linkScope: '/synthetic/cursor-session',
  });
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.source, 'cursor');
  assert.equal(session.agent, 'dashboard');
  assert.equal(session.startedAt, timestamp);
  assert.equal(session.endedAt, timestamp);
  assert.equal(session.label, 'Update the synthetic dashboard card');
  assert.equal(session.stats.messages, 3);
  assert.equal(session.stats.toolCounts.StrReplace, 1);
  assert.equal(session.stats.toolCounts.Write, 1);
  assert.equal(session.stats.errors, 1);
  assert.equal(session.events.find((event) => event.tool?.name === 'StrReplace').tool.confirmed, true);
  assert.equal(session.events.find((event) => event.tool?.name === 'Write').tool.confirmed, true);
  assert.equal(session.events.find((event) => event.tool?.name === 'Shell').tool.confirmed, undefined);
  assert.equal(session.events.find((event) => event.kind === 'meta').text, 'Synthetic test failure');
});

test('Cursor CLI stream-json parser coalesces deltas and links tool results', (t) => {
  const file = fixture(t, 'cursor-stream.jsonl', [
    {
      type: 'system',
      subtype: 'init',
      timestamp: '2026-07-26T10:00:00Z',
      session_id: '4b44aed4-495a-49db-8a93-4f375e07e3ea',
      cwd: '/workspace/cursor-project',
      model: 'claude-sonnet-4-6',
    },
    {
      type: 'user',
      timestamp: '2026-07-26T10:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'Read the file' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-26T10:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Reading ' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-07-26T10:00:02Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'now.' }] },
    },
    {
      type: 'tool_call',
      subtype: 'started',
      timestamp: '2026-07-26T10:00:03Z',
      call_id: 'call-1',
      tool_call: { readToolCall: { args: { path: '/workspace/cursor-project/file.js' } } },
    },
    {
      type: 'tool_call',
      subtype: 'completed',
      timestamp: '2026-07-26T10:00:04Z',
      call_id: 'call-1',
      tool_call: { readToolCall: { args: { path: '/workspace/cursor-project/file.js' }, result: { success: 'contents' } } },
    },
    {
      type: 'result',
      subtype: 'success',
      timestamp: '2026-07-26T10:00:05Z',
      is_error: false,
      result: 'Reading now.',
    },
  ]);

  const session = parseCursorFile(file).sessions[0];
  assert.equal(session.id, '4b44aed4-495a-49db-8a93-4f375e07e3ea');
  assert.equal(session.cwd, '/workspace/cursor-project');
  assert.equal(session.model, 'claude-sonnet-4-6');
  assert.equal(session.stats.messages, 2);
  assert.equal(session.events.find((event) => event.kind === 'assistant').text, 'Reading now.');
  const tool = session.events.find((event) => event.kind === 'tool').tool;
  assert.equal(tool.name, 'Read');
  assert.equal(tool.result, 'contents');
  assert.equal(tool.isError, false);
});

test('completed Cursor tool calls without an id keep their result', (t) => {
  const file = fixture(t, 'cursor-no-tool-id.jsonl', [{
    type: 'tool_call',
    subtype: 'completed',
    timestamp: '2026-07-26T10:00:04Z',
    tool_call: { readToolCall: { args: { path: 'file.js' }, result: { success: 'contents' } } },
  }]);
  const tool = parseCursorFile(file).sessions[0].events[0].tool;
  assert.equal(tool.result, 'contents');
  assert.equal(tool.resultTs, '2026-07-26T10:00:04Z');
});

test('Cursor adapter discovers native main and sub-agents without duplicate session groups', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-cursor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionId = '05b21f04-1e55-4e53-ae5e-fca29c77ffb3';
  const childId = 'cbaf15f9-36ec-481b-a96b-e8b2d3c4f857';
  const group = path.join(root, 'projects', 'demo-project', 'agent-transcripts', sessionId);
  fs.mkdirSync(path.join(group, 'subagents'), { recursive: true });
  fs.copyFileSync(CURSOR_FIXTURE, path.join(group, `${sessionId}.jsonl`));
  fs.writeFileSync(
    path.join(group, 'subagents', `${childId}.jsonl`),
    `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: 'Synthetic sub-agent task' }] } })}\n`,
  );
  const olderGroup = path.join(root, 'projects', 'older-copy', 'agent-transcripts', sessionId);
  fs.mkdirSync(olderGroup, { recursive: true });
  const olderMain = path.join(olderGroup, `${sessionId}.jsonl`);
  fs.copyFileSync(CURSOR_FIXTURE, olderMain);
  fs.utimesSync(olderMain, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

  const previous = process.env.CURSOR_STATE_DIR;
  process.env.CURSOR_STATE_DIR = root;
  const adapter = makeAdapters({ sources: ['cursor'] })[0];
  if (previous == null) delete process.env.CURSOR_STATE_DIR;
  else process.env.CURSOR_STATE_DIR = previous;

  const files = [...adapter.findFiles()];
  assert.equal(files.length, 2);
  assert.equal(files.every((file) => file.root === root), true);
  assert.equal(files.every((file) => file.agent === 'demo-project'), true);
  const sessions = files.flatMap((file) => adapter.parseFile(file).sessions);
  const parent = sessions.find((session) => session.id === sessionId);
  const child = sessions.find((session) => session.id === childId);
  assert.equal(child.intrinsicParent, parent.id);
  assert.equal(child.linkScope, parent.linkScope);
});

test('Gemini saved-session parser reads messages, tokens, thoughts, and tool outcomes', () => {
  const result = parseGeminiFile(GEMINI_FIXTURE, 'synthetic-project');
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.source, 'gemini');
  assert.equal(session.id, '5a915e99-d284-4c53-bc24-3012e2379974');
  assert.equal(session.cwd, '/workspace/gemini-project');
  assert.equal(session.label, 'Synthetic Gemini adapter session');
  assert.equal(session.model, 'gemini-3.1-pro-preview');
  assert.equal(session.stats.messages, 2);
  assert.equal(session.stats.tokensIn, 120);
  assert.equal(session.stats.tokensOut, 30);
  assert.equal(session.stats.tokensCacheRead, 40);
  assert.equal(session.stats.errors, 1);
  assert.equal(session.events.find((event) => event.kind === 'thinking').text.includes('Implementation'), true);
  const tools = session.events.filter((event) => event.kind === 'tool').map((event) => event.tool);
  assert.deepEqual(tools.map((tool) => tool.name), ['Edit', 'Write']);
  assert.equal(tools[0].result, 'Updated successfully');
  assert.equal(tools[0].resultTs, '2026-07-26T11:00:03Z');
  assert.equal(tools[0].isError, false);
  assert.equal(tools[1].result, 'Permission denied');
  assert.equal(tools[1].resultTs, '2026-07-26T11:00:04Z');
  assert.equal(tools[1].isError, true);
});

test('Gemini parser accepts pretty-printed legacy JSON documents', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-gemini-json-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.json');
  fs.writeFileSync(file, JSON.stringify({
    sessionId: 'pretty-gemini-session',
    projectHash: 'synthetic-project',
    startTime: '2026-07-26T11:00:00Z',
    lastUpdated: '2026-07-26T11:00:01Z',
    directories: ['/workspace/gemini-project'],
    messages: [
      { id: 'user-1', type: 'user', timestamp: '2026-07-26T11:00:00Z', content: [{ text: 'Read this JSON' }] },
      { id: 'assistant-1', type: 'gemini', timestamp: '2026-07-26T11:00:01Z', content: [{ text: 'Done' }], model: 'gemini-3-flash-preview' },
    ],
  }, null, 2));

  const result = parseGeminiFile(file);
  assert.equal(result.diagnostics.malformedLines, 0);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'pretty-gemini-session');
  assert.equal(result.sessions[0].stats.messages, 2);
});

test('invalid Gemini stream-shaped rows do not suppress valid legacy data', (t) => {
  const file = fixture(t, 'gemini-invalid-stream-then-legacy.jsonl', [
    {
      type: 'message',
      timestamp: '2100-01-01T00:00:00Z',
      role: 'assistant',
      content: { invalid: true },
    },
    {
      sessionId: 'legacy-after-invalid-stream',
      projectHash: 'synthetic-project',
      startTime: '2026-07-26T11:00:00Z',
      lastUpdated: '2026-07-26T11:00:01Z',
      messages: [
        {
          id: 'legacy-user',
          type: 'user',
          timestamp: '2026-07-26T11:00:00Z',
          content: [{ text: 'Keep the legacy session' }],
        },
        {
          id: 'legacy-assistant',
          type: 'gemini',
          timestamp: '2026-07-26T11:00:01Z',
          content: [{ text: 'Preserved' }],
        },
      ],
    },
  ]);

  const result = parseGeminiFile(file);
  assert.equal(result.diagnostics.rowErrors, 1);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'legacy-after-invalid-stream');
  assert.deepEqual(
    result.sessions[0].events.map((event) => event.text),
    ['Keep the legacy session', 'Preserved'],
  );
});

test('deep Gemini thought timestamps inherit the normalized message timestamp', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-gemini-thought-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'deep-thought.jsonl');
  const deepTimestamp = `${'['.repeat(20_000)}0${']'.repeat(20_000)}`;
  fs.writeFileSync(file, [
    JSON.stringify({
      sessionId: 'deep-thought-session',
      projectHash: 'synthetic-project',
      startTime: '2026-07-26T11:00:00Z',
      lastUpdated: '2026-07-26T11:00:01Z',
    }),
    `{"id":"assistant-1","type":"gemini","timestamp":"2026-07-26T11:00:01Z","content":[{"text":"Done"}],"thoughts":[{"text":"Think","timestamp":${deepTimestamp}}]}`,
  ].join('\n'));

  const result = parseGeminiFile(file);
  assert.equal(result.diagnostics.rowErrors, 0);
  const session = result.sessions[0];
  assert.equal(
    session.events.find((event) => event.kind === 'thinking').ts,
    '2026-07-26T11:00:01Z',
  );
  assert.doesNotThrow(() => buildStats([session], {
    days: Infinity,
    now: Date.parse('2026-07-30T12:00:00Z'),
  }));
});

test('Gemini stream-json parser coalesces deltas, links tools, and records model usage', (t) => {
  const file = fixture(t, 'gemini-stream.jsonl', [
    {
      type: 'init',
      timestamp: '2026-07-26T12:00:00Z',
      session_id: '0359939f-888d-4f3f-9635-583b1a796b12',
      model: 'gemini-3-flash-preview',
    },
    {
      type: 'message',
      timestamp: '2026-07-26T12:00:01Z',
      role: 'user',
      content: 'Read the dashboard',
    },
    {
      type: 'message',
      timestamp: '2026-07-26T12:00:02Z',
      role: 'assistant',
      content: 'Reading ',
      delta: true,
    },
    {
      type: 'message',
      timestamp: '2026-07-26T12:00:02Z',
      role: 'assistant',
      content: 'now.',
      delta: true,
    },
    {
      type: 'tool_use',
      timestamp: '2026-07-26T12:00:03Z',
      tool_name: 'read_file',
      tool_id: 'gemini-tool-1',
      parameters: { file_path: '/workspace/dashboard/README.md' },
    },
    {
      type: 'tool_result',
      timestamp: '2026-07-26T12:00:04Z',
      tool_id: 'gemini-tool-1',
      status: 'success',
      output: 'Dashboard documentation',
    },
    {
      type: 'result',
      timestamp: '2026-07-26T12:00:05Z',
      status: 'success',
      stats: {
        total_tokens: 80,
        input_tokens: 60,
        output_tokens: 20,
        cached: 15,
        input: 45,
        duration_ms: 5000,
        tool_calls: 1,
        models: {
          'gemini-3-flash-preview': {
            total_tokens: 80,
            input_tokens: 60,
            output_tokens: 20,
            cached: 15,
            input: 45,
          },
        },
      },
    },
  ]);

  const session = parseGeminiFile(file).sessions[0];
  assert.equal(session.id, '0359939f-888d-4f3f-9635-583b1a796b12');
  assert.equal(session.model, 'gemini-3-flash-preview');
  assert.equal(session.stats.messages, 2);
  assert.equal(session.events.find((event) => event.kind === 'assistant').text, 'Reading now.');
  assert.equal(session.stats.tokensIn, 60);
  assert.equal(session.stats.tokensOut, 20);
  assert.equal(session.stats.tokensCacheRead, 15);
  const tool = session.events.find((event) => event.kind === 'tool').tool;
  assert.equal(tool.name, 'Read');
  assert.equal(tool.result, 'Dashboard documentation');
});

test('Gemini adapter discovers main and nested sub-agent sessions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-gemini-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentId = '5a915e99-d284-4c53-bc24-3012e2379974';
  const childId = '5c865e4c-b44c-4b20-9bd7-dacbc27a101c';
  const chats = path.join(root, 'tmp', 'synthetic-project', 'chats');
  fs.mkdirSync(path.join(chats, parentId), { recursive: true });
  fs.copyFileSync(GEMINI_FIXTURE, path.join(chats, `session-2026-07-26T11-00-${parentId.slice(0, 8)}.jsonl`));
  fs.writeFileSync(
    path.join(chats, parentId, `${childId}.jsonl`),
    [
      {
        sessionId: childId,
        projectHash: 'synthetic-project',
        startTime: '2026-07-26T11:00:03Z',
        lastUpdated: '2026-07-26T11:00:04Z',
        kind: 'subagent',
      },
      {
        id: 'child-user',
        timestamp: '2026-07-26T11:00:03Z',
        type: 'user',
        content: [{ text: 'Inspect the synthetic fixture' }],
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n',
  );

  const previous = process.env.GEMINI_STATE_DIR;
  process.env.GEMINI_STATE_DIR = root;
  const adapter = makeAdapters({ sources: ['gemini'] })[0];
  if (previous == null) delete process.env.GEMINI_STATE_DIR;
  else process.env.GEMINI_STATE_DIR = previous;

  const files = [...adapter.findFiles()];
  assert.equal(files.length, 2);
  assert.equal(files.every((file) => file.agent === 'synthetic-project'), true);
  const sessions = files.flatMap((file) => adapter.parseFile(file).sessions);
  const parent = sessions.find((session) => session.id === parentId);
  const child = sessions.find((session) => session.id === childId);
  assert.equal(child.intrinsicParent, parent.id);
  assert.equal(child.linkScope, parent.linkScope);
});

test('JSONL reader refuses oversized transcripts before reading them', (t) => {
  const file = fixture(t, 'large.jsonl', [{ value: '1234567890' }]);
  const result = readJsonLines(file, 4);
  assert.equal(result.rows.length, 0);
  assert.equal(result.diagnostics.tooLarge, true);
});

test('JSONL reader streams large UTF-8 rows safely across chunk boundaries', (t) => {
  const file = fixture(t, 'chunked.jsonl', [{ value: `${'a'.repeat(65_524)}😀tail` }]);
  const seen = [];
  const result = readJsonLines(file, 1024 * 1024, (row) => seen.push(row));
  assert.equal(result.rows.length, 0);
  assert.equal(result.diagnostics.streamed, true);
  assert.equal(result.diagnostics.parsedLines, 1);
  assert.equal(seen[0].value.endsWith('😀tail'), true);
  assert.equal(seen[0].value.length, 65_530);
});

test('JSONL reader rejects symbolic links', (t) => {
  const target = fixture(t, 'target.jsonl', [{ value: 1 }]);
  const link = path.join(path.dirname(target), 'link.jsonl');
  try {
    fs.symlinkSync(target, link);
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('symbolic links are disabled in this environment');
      return;
    }
    throw err;
  }
  const result = readJsonLines(link);
  assert.equal(result.rows.length, 0);
  assert.equal(result.diagnostics.symlinkRejected, true);
});

test('HTML, XML, and JSX-like prompts are preserved while known metadata envelopes are skipped', (t) => {
  const generic = fixture(t, 'markup-generic.jsonl', [
    { type: 'session', id: 'markup-session', timestamp: '2026-07-20T10:00:00Z' },
    { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'user', content: '<div>fix this HTML</div>' } },
    { type: 'message', timestamp: '2026-07-20T10:00:02Z', message: { role: 'user', content: '<environment_context>injected</environment_context>' } },
    { type: 'message', timestamp: '2026-07-20T10:00:03Z', message: { role: 'assistant', content: 'Done' } },
  ]);
  const genericUsers = parseGenericAgentFile('hermes', generic, 'main').sessions[0].events
    .filter((event) => event.kind === 'user')
    .map((event) => event.text);
  assert.deepEqual(genericUsers, ['<div>fix this HTML</div>']);

  const codex = fixture(t, 'rollout-markup.jsonl', [
    { type: 'session_meta', timestamp: '2026-07-20T10:00:00Z', payload: { id: 'markup-codex', cwd: '/workspace/project' } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<Widget enabled={a < b} />' }] } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:02Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\nInjected' }] } },
    { type: 'response_item', timestamp: '2026-07-20T10:00:03Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } },
  ]);
  const codexUsers = parseCodexFile(codex).sessions[0].events
    .filter((event) => event.kind === 'user')
    .map((event) => event.text);
  assert.deepEqual(codexUsers, ['<Widget enabled={a < b} />']);
});

test('invalid transcript session ids fall back safely and are diagnosed', (t) => {
  for (const [index, invalidId] of [42, { nested: true }, null, 'x'.repeat(513)].entries()) {
    const file = fixture(t, `invalid-${index}.jsonl`, [
      { type: 'session', id: invalidId, timestamp: '2026-07-20T10:00:00Z' },
      { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'user', content: 'Keep parsing' } },
      { type: 'message', timestamp: '2026-07-20T10:00:02Z', message: { role: 'assistant', content: 'Done' } },
    ]);
    const result = parseGenericAgentFile('hermes', file, 'main');
    assert.equal(result.sessions.length, 1);
    assert.equal(typeof result.sessions[0].id, 'string');
    assert.ok(result.sessions[0].id.length > 0);
    assert.ok(result.sessions[0].id.length <= 512);
    assert.equal(result.diagnostics.invalidSessionIds, 1);
  }
});

test('Hermes fixture parses usage, tool results, and source identity', () => {
  const result = parseGenericAgentFile('hermes', HERMES_FIXTURE, 'hermes-fixture');
  assert.equal(result.sessions.length, 1);
  const session = result.sessions[0];
  assert.equal(session.source, 'hermes');
  assert.equal(session.id, 'hermes-fixture');
  assert.equal(session.cwd, '/workspace/hermes-project');
  assert.equal(session.label, 'Inspect the Hermes adapter');
  assert.equal(session.usage.length, 2);
  assert.equal(session.usage[0].cacheWrite5m, 2);
  assert.equal(session.usage[0].cacheWrite1h, 1);
  assert.equal(session.events.find((event) => event.kind === 'tool').tool.result, 'export const hermes = true;');
});

test('Hermes adapter discovers nested JSONL fixtures inside its configured root', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-hermes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'projects', 'demo');
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(HERMES_FIXTURE, path.join(directory, 'session.jsonl'));

  const adapter = makeAdapters({ sources: ['hermes'], hermesDir: root })[0];

  const files = [...adapter.findFiles()];
  assert.equal(files.length, 1);
  assert.equal(files[0].root, root);
  assert.equal(files[0].agent, 'demo');
  assert.equal(adapter.parseFile(files[0]).sessions[0].source, 'hermes');
});

test('API log importer normalizes OpenAI, Anthropic, Ollama, and LM Studio sessions', () => {
  const result = parseApiLogFile(API_LOG_FIXTURE);
  assert.equal(result.sessions.length, 4);
  assert.equal(result.diagnostics.malformedLines, 0);

  const byRuntime = new Map(result.sessions.map((session) => [session.runtime, session]));
  assert.equal(byRuntime.get('OpenAI API').provider, 'openai');
  assert.equal(byRuntime.get('OpenAI API').stats.tokensIn, 120);
  assert.equal(byRuntime.get('OpenAI API').stats.tokensCacheRead, 20);
  assert.equal(byRuntime.get('Anthropic API').provider, 'anthropic');
  assert.equal(byRuntime.get('Anthropic API').stats.tokensIn, 95);
  assert.equal(byRuntime.get('Ollama').provider, 'local');
  assert.equal(byRuntime.get('Ollama').model, 'llama3.2');
  assert.equal(byRuntime.get('LM Studio').provider, 'local');
  assert.equal(byRuntime.get('LM Studio').stats.tokensOut, 18);
  assert.equal(byRuntime.get('LM Studio').events.find((event) => event.kind === 'tool').tool.confirmed, true);
});

test('LM Studio invalid tool-call reasons are normalized to display-safe text', (t) => {
  const file = fixture(t, 'lm-studio-invalid-tool.jsonl', [{
    provider: 'lm-studio',
    session_id: 'lm-studio-invalid-tool',
    timestamp: '2026-07-20T10:03:00Z',
    request: { model: 'openai/gpt-oss-20b', input: 'Run a tool' },
    response: {
      model_instance_id: 'openai/gpt-oss-20b',
      output: [{
        type: 'invalid_tool_call',
        metadata: { tool_name: 'run_tests', arguments: { suite: 'unit' } },
        reason: { bad: true },
      }],
      stats: { input_tokens: 8, total_output_tokens: 2 },
    },
  }]);
  const result = parseApiLogFile(file);
  assert.equal(result.diagnostics.rowErrors, 0);
  const tool = result.sessions[0].events.find((event) => event.kind === 'tool').tool;
  assert.equal(tool.result, 'Invalid tool call');
  assert.equal(typeof tool.result, 'string');
  assert.equal(tool.isError, true);
});

test('API log importer attributes requested OpenAI-compatible model providers', (t) => {
  const providers = [
    ['nvidia', 'nvidia/nemotron', 'nvidia'],
    ['moonshot', 'kimi-k3', 'moonshot'],
    ['zhipu', 'glm-5.2', 'zhipu'],
    ['alibaba', 'qwen-3.6', 'alibaba'],
    ['mistral', 'mistral-large', 'mistral'],
  ];
  const file = fixture(t, 'provider-models.jsonl', providers.map(
    ([provider, model], index) => ({
      provider,
      session_id: `provider-${index}`,
      timestamp: `2026-07-20T10:0${index}:00Z`,
      request: { model, input: `Review with ${model}` },
      response: { model, output_text: 'Done', usage: { input_tokens: 10, output_tokens: 2 } },
    }),
  ));
  const result = parseApiLogFile(file);
  assert.equal(result.sessions.length, providers.length);
  assert.deepEqual(
    result.sessions.map((session) => session.provider).sort(),
    providers.map((entry) => entry[2]).sort(),
  );
});

test('API log text extraction stops at a bounded nesting depth', (t) => {
  let nested = 'too deep';
  for (let depth = 0; depth < 40; depth++) nested = { content: nested };
  const file = fixture(t, 'deep-api-content.jsonl', [{
    provider: 'openai',
    session_id: 'deep-content',
    timestamp: '2026-07-20T10:00:00Z',
    request: { model: 'gpt-5.3-codex', input: nested },
    response: {
      model: 'gpt-5.3-codex',
      output_text: 'Later response still parses',
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  }]);
  const result = parseApiLogFile(file);
  assert.equal(result.diagnostics.rowErrors, 0);
  assert.equal(result.sessions.length, 1);
  assert.equal(
    result.sessions[0].events.some((event) => event.text === 'Later response still parses'),
    true,
  );
});

test('malformed API-log rows cannot mutate an existing imported session', (t) => {
  const file = fixture(t, 'transactional-api-log.jsonl', [
    {
      provider: 'openai',
      session_id: 'transactional-api',
      timestamp: '2026-07-20T10:00:00Z',
      request: { model: 'gpt-5.3-codex', input: 'First' },
      response: { model: 'gpt-5.3-codex', output_text: 'One' },
    },
    {
      provider: 'openai',
      session_id: 'transactional-api',
      timestamp: '2099-01-01T00:00:00Z',
      request: { model: 'poisoned-model', input: 'Bad' },
      response: { model: 'poisoned-model', output: {} },
    },
    {
      provider: 'openai',
      session_id: 'transactional-api',
      timestamp: '2100-01-01T00:00:00Z',
      request: { model: 'poisoned-model', input: 'Also bad' },
      response: {
        model: 'poisoned-model',
        choices: [{ message: { tool_calls: [null] } }],
      },
    },
    {
      provider: 'openai',
      session_id: 'transactional-api',
      timestamp: '2026-07-20T10:00:02Z',
      request: { model: 'gpt-5.3-codex', input: 'Second' },
      response: { model: 'gpt-5.3-codex', output_text: 'Two' },
    },
  ]);
  const result = parseApiLogFile(file);
  assert.equal(result.diagnostics.rowErrors, 2);
  assert.equal(result.sessions.length, 1);
  assert.equal(
    Date.parse(result.sessions[0].endedAt),
    Date.parse('2026-07-20T10:00:02Z'),
  );
  assert.equal(result.sessions[0].model, 'gpt-5.3-codex');
  assert.equal(result.sessions[0].events.some((event) => event.text === 'Bad'), false);
});

test('API log importer gives long session identifiers stable unique fallbacks', (t) => {
  const firstId = 'a'.repeat(600);
  const secondId = 'b'.repeat(600);
  const file = fixture(t, 'long-api-ids.jsonl', [
    { provider: 'openai', session_id: firstId, timestamp: '2026-07-20T10:00:00Z', request: { input: 'First' }, response: { output_text: 'One' } },
    { provider: 'openai', session_id: secondId, timestamp: '2026-07-20T10:00:01Z', request: { input: 'Second' }, response: { output_text: 'Two' } },
  ]);

  const first = parseApiLogFile(file);
  const second = parseApiLogFile(file);
  assert.equal(first.sessions.length, 2);
  assert.equal(first.diagnostics.invalidSessionIds, 2);
  assert.equal(new Set(first.sessions.map((session) => session.id)).size, 2);
  assert.equal(first.sessions.every((session) => session.id.length <= 512), true);
  assert.deepEqual(
    first.sessions.map((session) => session.id),
    second.sessions.map((session) => session.id),
  );
});

test('API log importer skips out-of-range numeric timestamps without aborting the file', (t) => {
  const file = fixture(t, 'timestamp-range.jsonl', [
    { provider: 'openai', session_id: 'timestamp-range', timestamp: 1e100, request: { input: 'First' }, response: { output_text: 'One' } },
    { provider: 'openai', session_id: 'timestamp-range', timestamp: '2026-07-20T10:00:01Z', request: { input: 'Second' }, response: { output_text: 'Two' } },
  ]);
  const result = parseApiLogFile(file);
  assert.equal(result.diagnostics.readError, null);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].events.some(
    (event) => Date.parse(event.ts) === Date.parse('2026-07-20T10:00:01Z'),
  ), true);
});

test('API log adapter is only enabled for an explicit import directory', () => {
  assert.equal(makeAdapters({ sources: ['api-log'] }).length, 0);
  const adapters = makeAdapters({
    sources: ['api-log'],
    importDir: path.dirname(API_LOG_FIXTURE),
  });
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].source, 'api-log');
  assert.deepEqual(
    [...adapters[0].findFiles()].map((entry) => entry.file),
    [API_LOG_FIXTURE],
  );
});
