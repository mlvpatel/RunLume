import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDashboard,
  isAuthorized,
  isRequestAuthorized,
  isAllowedHost,
  isAllowedOrigin,
  isDocumentNavigation,
  isRealPathWithin,
  latestSessionMs,
  parseConfig,
  redactedStats,
  sessionPageForApi,
  start,
} from '../server.mjs';
import { buildStats } from '../analytics.mjs';

const pricingFile = fileURLToPath(new URL('../pricing.json', import.meta.url));
const quietLogger = { log() {}, warn() {}, error() {} };

function requestStatus(port, host) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/dashboard',
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

function stateDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-server-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeSession(root, agent, id, rows) {
  const directory = path.join(root, 'agents', agent, 'sessions');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${id}.jsonl`);
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return file;
}

function genericRows(id, timestamp = '2026-07-20T10:00:00Z') {
  return [
    { type: 'session', id, timestamp, cwd: '/workspace/project' },
    { type: 'message', timestamp, message: { role: 'user', content: 'Hello' } },
    { type: 'message', timestamp, message: { role: 'assistant', model: 'claude-opus-4-8', content: 'Done' } },
  ];
}

function config(hermesDir, overrides = {}) {
  return {
    port: 4477,
    days: Infinity,
    hermesDir,
    importDir: null,
    sources: ['hermes'],
    pricingFile,
    ...overrides,
  };
}

test('host and origin validation blocks DNS-rebinding names', () => {
  for (const host of ['localhost:4477', '127.0.0.1:4477', '[::1]:4477']) {
    assert.equal(isAllowedHost(host, 4477), true);
  }
  for (const host of [
    'example.com:4477',
    'localhost.example.com:4477',
    '127.0.0.1:9999',
    'localhost',
    'evil.test@localhost:4477',
    'localhost:4477/path',
    '',
    'bad host',
  ]) {
    assert.equal(isAllowedHost(host, 4477), false);
  }
  assert.equal(isAllowedOrigin('http://localhost:4477', 4477), true);
  assert.equal(isAllowedOrigin('https://localhost:4477', 4477), false);
  assert.equal(isAllowedOrigin('http://evil.test@localhost:4477', 4477), false);
  assert.equal(isAllowedOrigin('https://example.com:4477', 4477), false);
});

test('Bearer authentication uses the per-launch capability token', () => {
  const token = 'a'.repeat(43);
  assert.equal(isAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isAuthorized(`Bearer ${'b'.repeat(43)}`, token), false);
  assert.equal(isAuthorized(token, token), false);
  assert.equal(isAuthorized(null, token), false);
  assert.equal(isRequestAuthorized({ cookie: `other=value; runlume_access=${token}` }, token), false);
  assert.equal(isRequestAuthorized({ cookie: 'runlume_access=invalid!' }, token), false);
  assert.equal(isRequestAuthorized({}, null), false);
});

test('document bootstrap accepts only direct or same-origin navigation', () => {
  const request = (headers = {}, method = 'GET') => ({ method, headers });
  assert.equal(isDocumentNavigation(request()), true);
  assert.equal(isDocumentNavigation(request({
    'sec-fetch-site': 'none',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  })), true);
  assert.equal(isDocumentNavigation(request({
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document',
  })), true);
  for (const site of ['cross-site', 'same-site']) {
    assert.equal(isDocumentNavigation(request({
      'sec-fetch-site': site,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    })), false);
  }
  assert.equal(isDocumentNavigation(request({ origin: 'http://localhost:4477' })), false);
  assert.equal(isDocumentNavigation(request({}, 'HEAD')), false);
});

test('latest activity calculation remains stack safe for large sessions', () => {
  const events = Array.from({ length: 130_000 }, (_, index) => ({
    ts: index === 129_999 ? '2026-07-21T00:00:00Z' : '2026-07-20T00:00:00Z',
  }));
  assert.equal(latestSessionMs({
    startedAt: '2026-07-19T00:00:00Z',
    endedAt: null,
    events,
  }), Date.parse('2026-07-21T00:00:00Z'));
  assert.equal(latestSessionMs({
    startedAt: '2026-07-19T00:00:00Z',
    endedAt: '2100-01-01T00:00:00Z',
    events: [
      { ts: '2026-07-21T00:00:00Z' },
      { ts: '2100-01-02T00:00:00Z' },
    ],
  }, Date.parse('2026-07-30T00:00:00Z')), Date.parse('2026-07-21T00:00:00Z'));
});

test('session API pages are complete and redact sensitive transcript content by default', () => {
  const events = Array.from({ length: 350 }, (_, index) => ({
    kind: 'user',
    ts: '2026-07-20T10:00:00Z',
    text: `secret event ${index} at /Users/example/private`,
  }));
  events[300] = {
    kind: 'tool',
    ts: '2026-07-20T10:00:00Z',
    tool: {
      id: 'call-300',
      name: 'exec',
      args: { password: 'secret', path: '/Users/example/private' },
      result: 'secret result',
      isError: false,
      resultTs: '2026-07-20T10:00:01Z',
    },
  };
  const session = {
    key: 'codex:public-key',
    id: 'raw-session-id',
    source: 'codex',
    agent: 'private-project',
    file: '/Users/example/.codex/session.jsonl',
    cwd: '/Users/example/private',
    label: 'Secret task',
    model: null,
    startedAt: '2026-07-20T10:00:00Z',
    endedAt: '2026-07-20T10:00:01Z',
    parent: null,
    children: [],
    events,
    stats: {
      toolCounts: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`tool-${index}`, 1])),
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      messages: 349,
      errors: 0,
    },
  };

  const redacted = sessionPageForApi(session, null, { offset: 300, limit: 25 });
  assert.equal(redacted.page.total, 350);
  assert.equal(redacted.page.offset, 300);
  assert.equal(redacted.page.nextOffset, 325);
  assert.equal(redacted.events.length, 25);
  assert.equal(redacted.events[0].tool.args.redacted, true);
  assert.equal(redacted.events[0].tool.result, '[redacted tool result]');
  assert.equal(redacted.label, 'Session public-k');
  assert.equal(redacted.agent, 'local agent');
  assert.equal(Object.keys(redacted.stats.toolCounts).length, 250);
  assert.equal(redacted.stats.toolNamesOmitted, 50);
  assert.equal(redacted.stats.toolCallsTotal, 300);

  const raw = sessionPageForApi(session, null, {
    offset: 300,
    limit: 25,
    revealSensitive: true,
  });
  assert.equal(raw.sensitiveContentRevealed, true);
  assert.equal(raw.events[0].tool.args.password, 'secret');
  assert.equal(raw.events[0].tool.result, 'secret result');
  assert.equal(raw.label, 'Secret task');
});

test('aggregate API collections are capped with explicit omission counts', () => {
  const toolCounts = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`tool-${index}`, 1]));
  const events = Object.keys(toolCounts).map((name) => ({
    kind: 'tool',
    ts: '2026-07-20T10:00:00Z',
    tool: {
      id: name,
      name,
      args: {},
      result: 'ok',
      isError: false,
      resultTs: '2026-07-20T10:00:01Z',
      confirmed: true,
    },
  }));
  const stats = buildStats([{
    key: 'hermes:bounded',
    id: 'bounded',
    source: 'hermes',
    agent: 'test',
    file: '/tmp/bounded.jsonl',
    cwd: '/workspace/project',
    label: 'Bounded',
    model: null,
    provider: null,
    runtime: null,
    startedAt: '2026-07-20T10:00:00Z',
    endedAt: '2026-07-20T10:00:01Z',
    parent: null,
    children: [],
    events,
    usage: [],
    stats: {
      toolCounts,
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      messages: 0,
      errors: 0,
    },
  }], { days: Infinity, pricing: null });
  const safe = redactedStats(stats);
  assert.equal(safe.tools.length, 250);
  assert.deepEqual(safe.outputLimits.tools, { total: 300, shown: 250, omitted: 50 });
});

test('aggregate redaction keeps shared file and directory labels consistent', () => {
  const first = {
    project: '/workspace/one',
    path: 'src/a.js',
    directory: 'src',
  };
  const second = {
    project: '/workspace/two',
    path: 'src/b.js',
    directory: 'src',
  };
  const safe = redactedStats({
    tools: [],
    models: [],
    providers: [],
    impact: {
      files: [first, second],
      churnFiles: [first],
      directories: [
        { project: '/workspace/two', path: 'src' },
        { project: '/workspace/one', path: 'src' },
      ],
    },
    cost: { sessions: [] },
    records: { longestSession: null },
  });
  assert.equal(safe.impact.files[0].path, 'File 1');
  assert.equal(safe.impact.churnFiles[0].path, 'File 1');
  assert.equal(safe.impact.files[0].directory, 'Directory 1');
  assert.equal(safe.impact.files[1].directory, 'Directory 2');
  assert.deepEqual(
    safe.impact.directories.map((directory) => directory.path),
    ['Directory 2', 'Directory 1'],
  );
});

test('aggregate redaction caps nested model-rate collections', () => {
  const rates = Array.from({ length: 300 }, (_, index) => ({
    id: `rate-${index}`,
    input: index,
    output: index,
  }));
  const safe = redactedStats({
    tools: [],
    models: [{ name: 'mixed-model', rates }],
    providers: [],
    impact: { files: [], churnFiles: [], directories: [] },
    cost: { sessions: [] },
    records: { longestSession: null },
  });
  assert.equal(safe.models[0].rates.length, 250);
  assert.deepEqual(safe.outputLimits.modelRates, {
    total: 300,
    shown: 250,
    omitted: 50,
  });
});

test('CLI configuration rejects ambiguous and invalid options', () => {
  assert.equal(parseConfig(['--all'], {}).days, Infinity);
  assert.equal(parseConfig(['--days', '7', '--sources', 'codex'], {}).days, 7);
  assert.deepEqual(parseConfig(['--sources', 'cursor'], {}).sources, ['cursor']);
  assert.deepEqual(parseConfig(['--sources', 'gemini'], {}).sources, ['gemini']);
  assert.equal(parseConfig(['--import-dir', './captures'], {}).importDir, path.resolve('./captures'));
  assert.equal(
    parseConfig([], { RUNLUME_IMPORT_DIR: './env-captures' }).importDir,
    path.resolve('./env-captures'),
  );
  assert.throws(() => parseConfig(['--days', '0'], {}), /invalid day window/);
  assert.throws(() => parseConfig(['--days', '3651'], {}), /expected 1-3650/);
  assert.throws(() => parseConfig(['--port', '99999'], {}), /invalid port/);
  assert.throws(() => parseConfig(['--sources', 'unknown'], {}), /unknown source/);
  assert.throws(() => parseConfig(['--sources', ',,'], {}), /at least one source/);
  assert.throws(() => parseConfig(['--sources', 'api-log'], {}), /requires --import-dir/);
  assert.throws(() => parseConfig(['--port', '3000', '--port', '4000'], {}), /only be provided once/);
  assert.throws(() => parseConfig(['--all', '--all'], {}), /only be provided once/);
  assert.throws(() => parseConfig(['--dir', '.'], {}), /unknown option/);
  assert.throws(() => parseConfig(['--wat'], {}), /unknown option/);
  const emptyEnvironment = parseConfig([], {
    PORT: '',
    RUNLUME_IMPORT_DIR: ' ',
    RUNLUME_PRICING: '',
  });
  assert.equal(emptyEnvironment.port, 4477);
  assert.equal(emptyEnvironment.importDir, null);
  assert.equal(emptyEnvironment.pricingFile, pricingFile);
  const limited = parseConfig([], {
    RUNLUME_MAX_FILE_BYTES: '2048',
    RUNLUME_MAX_FILES: '12',
    RUNLUME_MAX_TOTAL_BYTES: '4096',
    RUNLUME_MAX_EVENTS: '34',
    RUNLUME_MAX_SESSIONS: '5',
    RUNLUME_MIN_REFRESH_MS: '0',
  });
  assert.deepEqual(limited.limits, {
    maxFileBytes: 2048,
    maxFiles: 12,
    maxTotalBytes: 4096,
    maxEvents: 34,
    maxSessions: 5,
    minRefreshMs: 0,
  });
  assert.throws(
    () => parseConfig([], { RUNLUME_MAX_EVENTS: '0' }),
    /MAX_EVENTS must be an integer of at least 1/,
  );
  assert.throws(
    () => parseConfig([], { RUNLUME_MAX_EVENTS: '2000001' }),
    /at most 2000000/,
  );
  assert.throws(
    () => createDashboard({ config: config('.', { days: 3651 }), logger: quietLogger }),
    /days to be 1-3650/,
  );
});

test('real-path containment rejects paths outside a transcript root', (t) => {
  const root = stateDir(t);
  const inside = path.join(root, 'inside.jsonl');
  fs.writeFileSync(inside, '{}\n');
  const outsideDirectory = stateDir(t);
  const outside = path.join(outsideDirectory, 'outside.jsonl');
  fs.writeFileSync(outside, '{}\n');
  assert.equal(isRealPathWithin(root, inside), true);
  assert.equal(isRealPathWithin(root, outside), false);
});

test('custom pricing files are regular, bounded files', (t) => {
  const root = stateDir(t);
  const oversizedPricing = path.join(root, 'pricing.json');
  fs.writeFileSync(oversizedPricing, ' '.repeat((2 * 1024 * 1024) + 1));
  const state = createDashboard({
    config: config(root, { pricingFile: oversizedPricing }),
    logger: quietLogger,
  }).getState(true);
  assert.match(state.diagnostics.pricingError, /exceeds 2097152 bytes/);
});

test('dashboard diagnostics aggregate adapter row errors without marking the file unreadable', (t) => {
  const root = stateDir(t);
  const id = '99999999-9999-4999-8999-999999999999';
  writeSession(root, 'main', id, [
    { type: 'session', id, timestamp: '2026-07-20T10:00:00Z' },
    { type: 'message', timestamp: '2100-01-01T00:00:00Z', message: { role: 'assistant', content: [null] } },
    { type: 'message', timestamp: '2026-07-20T10:00:02Z', message: { role: 'user', content: 'Later row' } },
  ]);
  const state = createDashboard({ config: config(root), logger: quietLogger }).getState(true);
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].label, 'Later row');
  assert.equal(state.diagnostics.rowErrors, 1);
  assert.equal(state.diagnostics.filesUnreadable, 0);
});

test('future transcript timestamps are excluded from selection and every API summary', async (t) => {
  const root = stateDir(t);
  const mixedId = '98989898-9898-4898-8989-989898989898';
  const futureOnlyId = '97979797-9797-4979-8979-979797979797';
  const now = Date.now;
  Date.now = () => Date.parse('2026-07-30T12:00:00Z');
  t.after(() => { Date.now = now; });

  writeSession(root, 'main', mixedId, [
    { type: 'session', id: mixedId, timestamp: '2026-07-20T10:00:00Z' },
    { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'user', content: 'Current activity' } },
    { type: 'message', timestamp: '2100-01-01T00:00:00Z', message: { role: 'assistant', content: 'Future clock' } },
  ]);
  writeSession(root, 'main', futureOnlyId, [
    { type: 'session', id: futureOnlyId, timestamp: '2100-01-01T00:00:00Z' },
    { type: 'message', timestamp: '2100-01-01T00:00:01Z', message: { role: 'user', content: 'Future only' } },
  ]);

  const dashboard = createDashboard({
    config: config(root, { days: 30 }),
    logger: quietLogger,
  });
  const state = dashboard.getState(true);
  assert.deepEqual(state.sessions.map((session) => session.id), [mixedId]);
  assert.equal(state.diagnostics.futureSessions, 2);
  assert.equal(state.analysisByKey.get(state.sessions[0].key).futureEventsOmitted, 1);
  assert.equal(state.analysisByKey.get(state.sessions[0].key).observed.messages, 1);

  await new Promise((resolve, reject) => {
    dashboard.server.once('error', reject);
    dashboard.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => dashboard.server.close());
  const port = dashboard.server.address().port;
  const headers = { Authorization: `Bearer ${dashboard.apiToken}` };
  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.sessions.length, 1);
  assert.equal(payload.sessions[0].endedAt, '2026-07-20T10:00:01.000Z');
  assert.equal(payload.sessions[0].stats.messages, 1);
  assert.equal(payload.sessions[0].eventCount, 1);

  const detailResponse = await fetch(
    `http://127.0.0.1:${port}/api/session?key=${encodeURIComponent(payload.sessions[0].key)}`,
    { headers },
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.endedAt, '2026-07-20T10:00:01.000Z');
  assert.equal(detail.stats.messages, 1);
  assert.equal(detail.eventCount, 1);
  assert.equal(detail.page.total, 1);
  assert.equal(detail.events.length, 1);
});

test('future tool calls and results cannot create spawn relationships', (t) => {
  const root = stateDir(t);
  const parentId = '10101010-1010-4010-8010-101010101010';
  const currentArgumentChild = '20202020-2020-4020-8020-202020202020';
  const currentResultChild = '30303030-3030-4030-8030-303030303030';
  const futureResultChild = '40404040-4040-4040-8040-404040404040';
  const futureCallChild = '50505050-5050-4050-8050-505050505050';

  writeSession(root, 'main', parentId, [
    { type: 'session', id: parentId, timestamp: '2026-07-20T10:00:00Z' },
    { type: 'message', timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'Delegate safely' } },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:01Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'current-argument',
          name: 'sessions_spawn',
          arguments: { child: currentArgumentChild },
        }],
      },
    },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:02Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'current-result',
          name: 'sessions_spawn',
          arguments: { task: 'current result' },
        }],
      },
    },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:03Z',
      message: {
        role: 'toolResult',
        toolCallId: 'current-result',
        content: `Spawned ${currentResultChild}`,
      },
    },
    {
      type: 'message',
      timestamp: '2026-07-20T10:00:04Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'future-result',
          name: 'sessions_spawn',
          arguments: { task: 'future result' },
        }],
      },
    },
    {
      type: 'message',
      timestamp: '2100-01-01T00:00:00Z',
      message: {
        role: 'toolResult',
        toolCallId: 'future-result',
        content: `Spawned ${futureResultChild}`,
      },
    },
    {
      type: 'message',
      timestamp: '2100-01-01T00:00:01Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'future-call',
          name: 'sessions_spawn',
          arguments: { child: futureCallChild },
        }],
      },
    },
  ]);
  for (const childId of [
    currentArgumentChild,
    currentResultChild,
    futureResultChild,
    futureCallChild,
  ]) {
    writeSession(root, 'main', childId, genericRows(childId));
  }

  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-07-30T12:00:00Z');
  t.after(() => { Date.now = originalNow; });
  const state = createDashboard({
    config: config(root, { days: 30 }),
    logger: quietLogger,
  }).getState(true);
  const parent = state.sessions.find((session) => session.id === parentId);
  const childrenById = new Map(state.sessions.map((session) => [session.id, session]));
  assert.deepEqual(
    new Set(parent.children),
    new Set([
      childrenById.get(currentArgumentChild).key,
      childrenById.get(currentResultChild).key,
    ]),
  );
  assert.equal(childrenById.get(futureResultChild).parent, null);
  assert.equal(childrenById.get(futureCallChild).parent, null);
  assert.equal(
    buildStats(state.sessions, {
      days: 30,
      pricing: state.pricing,
      analysisByKey: state.analysisByKey,
      now: state.scannedAt,
    }).totals.spawns,
    2,
  );
});

test('scan budgets cap files, sessions, bytes, and events with diagnostics', (t) => {
  const root = stateDir(t);
  writeSession(root, 'main', 'a-session', genericRows('a-session'));
  writeSession(root, 'main', 'b-session', genericRows('b-session'));

  const fileLimited = createDashboard({
    config: config(root, { limits: { maxFiles: 1, maxSessions: 10, maxEvents: 100, maxTotalBytes: 1_000_000 } }),
    logger: quietLogger,
  }).getState(true);
  assert.equal(fileLimited.sessions.length, 1);
  assert.equal(fileLimited.diagnostics.fileBudgetReached, true);

  const sessionLimited = createDashboard({
    config: config(root, { limits: { maxFiles: 10, maxSessions: 1, maxEvents: 100, maxTotalBytes: 1_000_000 } }),
    logger: quietLogger,
  }).getState(true);
  assert.equal(sessionLimited.sessions.length, 1);
  assert.equal(sessionLimited.diagnostics.sessionBudgetReached, true);

  const eventLimited = createDashboard({
    config: config(root, { limits: { maxFiles: 10, maxSessions: 10, maxEvents: 1, maxTotalBytes: 1_000_000 } }),
    logger: quietLogger,
  }).getState(true);
  assert.equal(eventLimited.sessions.length, 0);
  assert.equal(eventLimited.diagnostics.eventBudgetReached, true);
  assert.equal(eventLimited.diagnostics.sessionsSkippedEventBudget, 2);

  const byteLimited = createDashboard({
    config: config(root, { limits: { maxFiles: 10, maxSessions: 10, maxEvents: 100, maxTotalBytes: 1 } }),
    logger: quietLogger,
  }).getState(true);
  assert.equal(byteLimited.sessions.length, 0);
  assert.equal(byteLimited.diagnostics.filesSkippedByteBudget, 2);
});

test('per-file transcript limits are enforced by the dashboard configuration', (t) => {
  const root = stateDir(t);
  writeSession(root, 'main', 'oversized-session', genericRows('oversized-session'));
  const dashboard = createDashboard({
    config: config(root, {
      limits: {
        maxFileBytes: 16,
        maxFiles: 10,
        maxSessions: 10,
        maxEvents: 100,
        maxTotalBytes: 1_000_000,
      },
    }),
    logger: quietLogger,
  });
  const state = dashboard.getState(true);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.diagnostics.filesTooLarge, 1);
  assert.equal(state.diagnostics.bytesAccepted, 0);
});

test('transcript discovery rejects symbolic links', (t) => {
  const root = stateDir(t);
  const outsideRoot = stateDir(t);
  const outside = writeSession(outsideRoot, 'outside', 'outside-session', genericRows('outside-session'));
  const sessionsDir = path.join(root, 'agents', 'main', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const link = path.join(sessionsDir, 'linked.jsonl');
  try {
    fs.symlinkSync(outside, link);
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('symbolic links are disabled in this environment');
      return;
    }
    throw err;
  }
  const state = createDashboard({ config: config(root), logger: quietLogger }).getState(true);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.diagnostics.filesRejectedSymlink, 1);
});

test('session keys remain unique when raw ids collide across agents', (t) => {
  const root = stateDir(t);
  const id = '11111111-1111-4111-8111-111111111111';
  writeSession(root, 'alpha', id, genericRows(id));
  writeSession(root, 'beta', id, genericRows(id));
  const dashboard = createDashboard({ config: config(root), logger: quietLogger });
  const state = dashboard.getState(true);
  assert.equal(state.sessions.length, 2);
  assert.equal(new Set(state.sessions.map((session) => session.key)).size, 2);
  assert.equal(state.byKey.size, 2);
});

test('time windows use transcript activity rather than file modification time', (t) => {
  const root = stateDir(t);
  const id = '22222222-2222-4222-8222-222222222222';
  writeSession(root, 'main', id, genericRows(id, '2020-01-01T00:00:00Z'));
  const dashboard = createDashboard({ config: config(root, { days: 30 }), logger: quietLogger });
  const state = dashboard.getState(true);
  assert.equal(state.sessions.length, 0);
  assert.equal(state.roots.length, 1);
  assert.match(state.roots[0], /^hermes: /);
  assert.equal(state.diagnostics.sessionsOutsideWindow, 1);
});

test('spawn relationships are rebuilt instead of retained from cached objects', (t) => {
  const root = stateDir(t);
  const parentId = '33333333-3333-4333-8333-333333333333';
  const childId = '44444444-4444-4444-8444-444444444444';
  const parentFile = writeSession(root, 'main', parentId, [
    { type: 'session', id: parentId, timestamp: '2026-07-20T10:00:00Z' },
    { type: 'message', timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: 'Delegate' } },
    { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', arguments: { task: 'Child' } }] } },
    { type: 'message', timestamp: '2026-07-20T10:00:02Z', message: { role: 'toolResult', toolCallId: 'spawn-1', content: `Spawned ${childId}` } },
  ]);
  writeSession(root, 'main', childId, genericRows(childId));

  const dashboard = createDashboard({ config: config(root), logger: quietLogger });
  const first = dashboard.getState(true);
  assert.ok(first.sessions.find((session) => session.id === childId).parent);

  fs.writeFileSync(parentFile, `${genericRows(parentId).map((row) => JSON.stringify(row)).join('\n')}\n`);
  const future = new Date(Date.now() + 2_000);
  fs.utimesSync(parentFile, future, future);
  const second = dashboard.getState(true);
  assert.equal(second.sessions.find((session) => session.id === childId).parent, null);
});

test('cache invalidates same-size replacements even when modification time is restored', (t) => {
  const root = stateDir(t);
  const id = '66666666-6666-4666-8666-666666666666';
  const file = writeSession(root, 'main', id, genericRows(id));
  const dashboard = createDashboard({ config: config(root), logger: quietLogger });
  const first = dashboard.getState(true);
  assert.equal(first.sessions[0].label, 'Hello');

  const descriptor = fs.openSync(file, 'r');
  const originalStat = fs.fstatSync(descriptor);
  const original = fs.readFileSync(descriptor, 'utf8');
  fs.closeSync(descriptor);
  const replacement = original.replace('Hello', 'There');
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  const staged = `${file}.replacement`;
  fs.writeFileSync(staged, replacement);
  fs.utimesSync(staged, originalStat.atime, originalStat.mtime);
  fs.renameSync(staged, file);

  const second = dashboard.getState(true);
  assert.equal(second.sessions[0].label, 'There');
  assert.notEqual(fs.statSync(file).ino, originalStat.ino);
});

test('refresh throttling is based on the last scan and zero disables forced throttling', (t) => {
  const root = stateDir(t);
  const id = '88888888-8888-4888-8888-888888888888';
  const file = writeSession(root, 'main', id, genericRows(id));
  const originalNow = Date.now;
  let clock = originalNow();
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });

  const dashboard = createDashboard({
    config: config(root, { limits: { minRefreshMs: 60_000 } }),
    logger: quietLogger,
  });
  const first = dashboard.getState(true, true);
  assert.equal(first.sessions[0].label, 'Hello');

  fs.writeFileSync(file, `${genericRows(id).map((row) => JSON.stringify(
    row.type === 'message' && row.message?.role === 'user'
      ? { ...row, message: { ...row.message, content: 'Changed' } }
      : row,
  )).join('\n')}\n`);
  const future = new Date(originalNow() + 5_000);
  fs.utimesSync(file, future, future);
  clock += 2_000;
  assert.equal(dashboard.getState(false, true).sessions[0].label, 'Hello');
  assert.equal(dashboard.getState(true, true).sessions[0].label, 'Hello');
  assert.equal(first.diagnostics.refreshThrottled, 1);
  clock += 60_000;
  assert.equal(dashboard.getState(false, true).sessions[0].label, 'Changed');

  const unthrottled = createDashboard({
    config: config(root, { limits: { minRefreshMs: 0 } }),
    logger: quietLogger,
  });
  assert.equal(unthrottled.getState(true, true).sessions[0].label, 'Changed');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Changed', 'Updated'));
  fs.utimesSync(file, new Date(future.getTime() + 5_000), new Date(future.getTime() + 5_000));
  assert.equal(unthrottled.getState(true, true).sessions[0].label, 'Updated');
});

test('start binds the production server only to IPv4 loopback', async (t) => {
  const root = stateDir(t);
  const dashboard = start(config(root, { port: 0 }), quietLogger);
  t.after(() => dashboard.server.close());
  await new Promise((resolve, reject) => {
    if (dashboard.server.listening) return resolve();
    dashboard.server.once('listening', resolve);
    dashboard.server.once('error', reject);
  });
  const address = dashboard.server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.ok(address.port > 0);
});

test('request validation uses the actual bound port for exported dashboards', async (t) => {
  const root = stateDir(t);
  const dashboard = createDashboard({
    config: config(root, { port: 4477 }),
    logger: quietLogger,
  });
  await new Promise((resolve, reject) => {
    dashboard.server.once('error', reject);
    dashboard.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => dashboard.server.close());
  const port = dashboard.server.address().port;

  const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(unauthenticated.status, 401);
  const authenticated = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: { Authorization: `Bearer ${dashboard.apiToken}` },
  });
  assert.equal(authenticated.status, 200);
});

test('HTTP API emits security headers and rejects mutations', async (t) => {
  const root = stateDir(t);
  const id = '55555555-5555-4555-8555-555555555555';
  const sentinel = '/private/runlume-sentinel/prompt-secret';
  writeSession(root, 'main', id, [
    { type: 'session', id, timestamp: '2026-07-20T10:00:00Z', cwd: sentinel },
    { type: 'message', timestamp: '2026-07-20T10:00:00Z', message: { role: 'assistant', content: [null] } },
    { type: 'message', timestamp: '2026-07-20T10:00:00Z', message: { role: 'user', content: sentinel } },
    { type: 'message', timestamp: '2026-07-20T10:00:01Z', message: { role: 'assistant', model: 'claude-opus-4-8', content: 'Done' } },
  ]);
  const dashboard = createDashboard({
    config: config(root, { port: 0, limits: { minRefreshMs: 60_000 } }),
    logger: quietLogger,
  });
  try {
    await new Promise((resolve, reject) => {
      dashboard.server.once('error', reject);
      dashboard.server.listen(0, '127.0.0.1', resolve);
    });
  } catch (err) {
    if (err?.code === 'EPERM') {
      t.skip('local sockets are disabled in this sandbox');
      return;
    }
    throw err;
  }
  t.after(() => dashboard.server.close());
  const port = dashboard.server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /^Bearer /);

  const crossSiteHeaders = await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/',
      headers: {
        Host: `127.0.0.1:${port}`,
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      },
    }, (crossSiteResponse) => {
      crossSiteResponse.resume();
      crossSiteResponse.on('end', () => resolve(crossSiteResponse.headers));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(crossSiteHeaders['set-cookie'], undefined);

  const bootstrap = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(bootstrap.status, 200);
  const setCookie = bootstrap.headers.get('set-cookie');
  assert.match(setCookie, new RegExp(`^runlume_access_${port}=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=/$`));
  assert.equal(setCookie.includes(dashboard.apiToken), false);
  const cookie = setCookie.split(';', 1)[0];
  const cookieAuthenticated = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: { Cookie: cookie },
  });
  assert.equal(cookieAuthenticated.status, 200);
  const [cookieName] = cookie.split('=', 1);
  const staleCookieName = `runlume_access_${port + 1}`;
  assert.equal(cookieName, `runlume_access_${port}`);
  const staleCookie = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: { Cookie: `${staleCookieName}=invalid` },
  });
  assert.equal(staleCookie.status, 401);
  const staleAndCurrentCookie = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: { Cookie: `${staleCookieName}=invalid; ${cookie}` },
  });
  assert.equal(staleAndCurrentCookie.status, 200);
  const duplicateCookie = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
    headers: { Cookie: `${cookie}; ${cookie}` },
  });
  assert.equal(duplicateCookie.status, 401);

  const headers = { Authorization: `Bearer ${dashboard.apiToken}` };
  const authenticated = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { headers });
  assert.equal(authenticated.status, 200);
  assert.match(authenticated.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(authenticated.headers.get('content-security-policy'), /form-action 'none'/);
  assert.match(authenticated.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(authenticated.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(authenticated.headers.get('origin-agent-cluster'), '?1');
  assert.equal(authenticated.headers.get('x-content-type-options'), 'nosniff');
  const payload = await authenticated.json();
  assert.equal(payload.sessions.length, 1);
  assert.ok(payload.sessions[0].key);
  assert.equal(payload.sessions[0].events, undefined);
  assert.equal(payload.sessions[0].intelligence, undefined);
  assert.match(payload.sessions[0].label, /^Session /);
  assert.equal(payload.diagnostics.rowErrors, 1);
  assert.equal(JSON.stringify(payload).includes(sentinel), false);

  for (const endpoint of ['/api/state', '/api/stats']) {
    const protectedResponse = await fetch(`http://127.0.0.1:${port}${endpoint}`, { headers });
    assert.equal(protectedResponse.status, 200);
    assert.equal((await protectedResponse.text()).includes(sentinel), false);
  }
  const sessionResponse = await fetch(
    `http://127.0.0.1:${port}/api/session?key=${encodeURIComponent(payload.sessions[0].key)}`,
    { headers },
  );
  assert.equal(sessionResponse.status, 200);
  assert.equal((await sessionResponse.text()).includes(sentinel), false);

  const invalidSource = await fetch(`http://127.0.0.1:${port}/api/dashboard?source=disabled`, { headers });
  assert.equal(invalidSource.status, 400);

  const forced = await fetch(`http://127.0.0.1:${port}/api/dashboard?refresh=1`, { headers });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).diagnostics.refreshThrottled, 1);
  const throttled = await fetch(`http://127.0.0.1:${port}/api/dashboard?refresh=1`, { headers });
  assert.equal(throttled.status, 200);
  assert.equal((await throttled.json()).diagnostics.refreshThrottled, 2);

  const post = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { method: 'POST', headers });
  assert.equal(post.status, 405);
  const malformedPath = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
  assert.equal(malformedPath.status, 400);
  for (const unsafePath of [
    '/../server.mjs',
    '/%2e%2e%2fserver.mjs',
    '/%00',
    '/..\\server.mjs',
    '/../public-evil/index.html',
  ]) {
    const traversal = await fetch(`http://127.0.0.1:${port}${unsafePath}`);
    assert.equal(traversal.status, 404);
  }
  assert.equal(await requestStatus(port, `example.com:${port}`), 403);
  assert.equal(await requestStatus(port, 'bad_host'), 403);
});

test('session API applies the requested source before key lookup', async (t) => {
  const root = stateDir(t);
  const hermesId = '77777777-7777-4777-8777-777777777777';
  writeSession(root, 'main', hermesId, genericRows(hermesId));
  fs.writeFileSync(path.join(root, 'api-log.jsonl'), `${JSON.stringify({
    provider: 'openai',
    session_id: 'api-session',
    timestamp: '2026-07-20T10:00:00Z',
    request: { model: 'gpt-5.3-codex', input: 'Imported' },
    response: { model: 'gpt-5.3-codex', output_text: 'Done' },
  })}\n`);

  const dashboard = createDashboard({
    config: config(root, {
      port: 0,
      importDir: root,
      sources: ['hermes', 'api-log'],
      limits: { minRefreshMs: 0 },
    }),
    logger: quietLogger,
  });
  await new Promise((resolve, reject) => {
    dashboard.server.once('error', reject);
    dashboard.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => dashboard.server.close());
  const port = dashboard.server.address().port;
  const headers = { Authorization: `Bearer ${dashboard.apiToken}` };
  const stateResponse = await fetch(`http://127.0.0.1:${port}/api/state`, { headers });
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  const imported = state.sessions.find((session) => session.source === 'api-log');
  assert.ok(imported);

  const mismatched = await fetch(
    `http://127.0.0.1:${port}/api/session?source=hermes&key=${encodeURIComponent(imported.key)}`,
    { headers },
  );
  assert.equal(mismatched.status, 404);
  const matched = await fetch(
    `http://127.0.0.1:${port}/api/session?source=api-log&key=${encodeURIComponent(imported.key)}`,
    { headers },
  );
  assert.equal(matched.status, 200);
});
