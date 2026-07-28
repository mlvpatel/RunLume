import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  createDashboard,
  isAuthorized,
  isAllowedHost,
  isAllowedOrigin,
  isRealPathWithin,
  latestSessionMs,
  parseConfig,
  redactedStats,
  sessionPageForApi,
} from '../server.mjs';
import { buildStats } from '../analytics.mjs';

const pricingFile = path.resolve(new URL('../pricing.json', import.meta.url).pathname);
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
  assert.throws(() => parseConfig(['--sources', 'api-log'], {}), /requires --import-dir/);
  assert.throws(() => parseConfig(['--dir', '.'], {}), /unknown option/);
  assert.throws(() => parseConfig(['--wat'], {}), /unknown option/);
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

test('HTTP API emits security headers and rejects mutations', async (t) => {
  const root = stateDir(t);
  const id = '55555555-5555-4555-8555-555555555555';
  writeSession(root, 'main', id, genericRows(id));
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

  const invalidSource = await fetch(`http://127.0.0.1:${port}/api/dashboard?source=disabled`, { headers });
  assert.equal(invalidSource.status, 400);

  const forced = await fetch(`http://127.0.0.1:${port}/api/dashboard?refresh=1`, { headers });
  assert.equal(forced.status, 200);
  const throttled = await fetch(`http://127.0.0.1:${port}/api/dashboard?refresh=1`, { headers });
  assert.equal(throttled.status, 200);
  assert.equal((await throttled.json()).diagnostics.refreshThrottled, 1);

  const post = await fetch(`http://127.0.0.1:${port}/api/dashboard`, { method: 'POST', headers });
  assert.equal(post.status, 405);
  const malformedPath = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
  assert.equal(malformedPath.status, 400);
  assert.equal(await requestStatus(port, `example.com:${port}`), 403);
  assert.equal(await requestStatus(port, 'bad_host'), 403);
});
