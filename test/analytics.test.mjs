import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildStats,
  calendarWindowStart,
  dayKey,
  diffLineCounts,
  extractEditOperations,
  inferProvider,
  parsePatch,
  priceSession,
  validatePricing,
} from '../analytics.mjs';

const pricing = JSON.parse(fs.readFileSync(new URL('../pricing.json', import.meta.url), 'utf8'));

function makeSession(overrides = {}) {
  const id = overrides.id ?? 'session-1';
  const source = overrides.source ?? 'codex';
  return {
    id,
    key: overrides.key ?? `${source}:${id}`,
    source,
    agent: 'test',
    cwd: overrides.cwd ?? '/workspace/project',
    file: overrides.file ?? `/transcripts/${source}/${id}.jsonl`,
    label: overrides.label ?? 'test session',
    model: overrides.model ?? 'gpt-5.3-codex',
    provider: overrides.provider ?? null,
    runtime: overrides.runtime ?? null,
    startedAt: overrides.startedAt ?? '2026-07-18T10:00:00.000Z',
    endedAt: overrides.endedAt ?? '2026-07-18T10:00:10.000Z',
    parent: null,
    children: [],
    events: overrides.events ?? [],
    usage: overrides.usage ?? [],
    stats: {
      tokensIn: 1_000_000,
      tokensOut: 100_000,
      tokensCacheRead: 400_000,
      tokensCacheWrite: 0,
      messages: 2,
      errors: 0,
      toolCounts: {},
      ...overrides.stats,
    },
  };
}

const tool = (name, args, ts = '2026-07-18T10:00:03.000Z', extra = {}) => ({
  kind: 'tool', ts, tool: { name, args, result: 'ok', resultTs: '2026-07-18T10:00:05.000Z', isError: false, ...extra },
});

test('parsePatch returns a delta for every file in an apply_patch payload', () => {
  const result = parsePatch(`*** Begin Patch
*** Update File: src/a.js
@@
-old
+new
+another
*** Add File: src/b.js
+one
+two
*** End Patch`);
  assert.deepEqual(result, [
    { path: 'src/a.js', additions: 2, deletions: 1 },
    { path: 'src/b.js', additions: 2, deletions: 0 },
  ]);
});

test('extractEditOperations understands Claude Edit and embedded Codex patches', () => {
  assert.deepEqual(extractEditOperations(tool('Edit', {
    file_path: 'src/a.js', old_string: 'one\ntwo', new_string: 'one\nthree\nfour',
  })), [{ path: 'src/a.js', additions: 2, deletions: 1 }]);

  const wrapped = tool('exec', { input: 'await tools.apply_patch(`*** Begin Patch\\n*** Update File: src/b.js\\n@@\\n-old\\n+new\\n*** End Patch`)' });
  assert.deepEqual(extractEditOperations(wrapped), [{ path: 'src/b.js', additions: 1, deletions: 1 }]);

  const multilineWrapper = tool('exec', { input: 'const patch = "*** Begin Patch\\n*** Update File: src/c.js\\n@@\\n-before\\n+after\\n*** End Patch";\ntext(await tools.apply_patch(patch));' });
  assert.deepEqual(extractEditOperations(multilineWrapper), [{ path: 'src/c.js', additions: 1, deletions: 1 }]);

  const outerPatch = `*** Begin Patch
*** Add File: test/fixture.js
+const nested = '*** Begin Patch\\n*** Update File: fake.js\\n@@\\n-old\\n+new\\n*** End Patch';
*** End Patch`;
  const nestedFixture = tool('exec', { input: `const patch = ${JSON.stringify(outerPatch)};\ntext(await tools.apply_patch(patch));` });
  assert.deepEqual(extractEditOperations(nestedFixture), [{ path: 'test/fixture.js', additions: 1, deletions: 0 }]);
});

test('patch parsing requires an edit tool or explicit apply_patch wrapper', () => {
  const patch = `*** Begin Patch
*** Update File: src/a.js
@@
-old
+new
*** End Patch`;
  assert.deepEqual(extractEditOperations(tool('apply_patch', { patch })), [
    { path: 'src/a.js', additions: 1, deletions: 1 },
  ]);
  const unified = `--- a/src/a.js
+++ b/src/a.js
@@ -1 +1 @@
-old
+new`;
  assert.deepEqual(extractEditOperations(tool('apply_patch', { patch: unified })), [
    { path: 'src/a.js', additions: 1, deletions: 1 },
  ]);
  assert.deepEqual(extractEditOperations(tool('exec', {
    input: `const patch = ${JSON.stringify(unified)};\nawait tools.apply_patch(patch);`,
  })), [
    { path: 'src/a.js', additions: 1, deletions: 1 },
  ]);
  assert.deepEqual(extractEditOperations(tool('exec', {
    cmd: `apply_patch <<'PATCH'\n${patch}\nPATCH`,
  })), [
    { path: 'src/a.js', additions: 1, deletions: 1 },
  ]);
  assert.deepEqual(extractEditOperations(tool('exec', { input: patch })), []);
  assert.deepEqual(extractEditOperations(tool('preview_patch', { patch })), []);
  assert.deepEqual(extractEditOperations(tool('exec', {
    input: `const preview = "await tools.apply_patch(patch)";\n${patch}`,
  })), []);
  assert.deepEqual(extractEditOperations(tool('exec', {
    input: `// await tools.apply_patch(patch)\n${patch}`,
  })), []);
  for (const declaration of [
    `function apply_patch(patch) {}\nconst preview = ${JSON.stringify(patch)};`,
    `def apply_patch(patch):\n    return patch\npreview = ${JSON.stringify(patch)}`,
    `apply_patch() { :; }\npreview=${JSON.stringify(patch)}`,
    `const apply_patch = (patch) => patch;\nconst preview = ${JSON.stringify(patch)};\napply_patch(preview);`,
  ]) {
    assert.deepEqual(extractEditOperations(tool('exec', { input: declaration })), []);
  }
});

test('wrapped patches are bound to the invoked argument and ignore fixture text', () => {
  const fake = `*** Begin Patch
*** Update File: fake.js
@@
-old
+new
*** End Patch`;
  const real = `*** Begin Patch
*** Update File: real.js
@@
-old
+new
*** End Patch`;
  const appliedInput = [
    `const preview = ${JSON.stringify(fake)};`,
    `const patch = ${JSON.stringify(real)};`,
    'await tools.apply_patch(patch);',
  ].join('\n');
  assert.deepEqual(extractEditOperations(tool('exec', { input: appliedInput })), [
    { path: 'real.js', additions: 1, deletions: 1 },
  ]);

  const fixtureCommand = [
    'cat > fixture.js <<JS',
    'await tools.apply_patch(`*** Begin Patch',
    '*** Update File: fake.js',
    '@@',
    '-old',
    '+new',
    '*** End Patch`)',
    'JS',
  ].join('\n');
  assert.deepEqual(extractEditOperations(tool('exec_command', { cmd: fixtureCommand })), []);

  const fixtureThenReal = `${fixtureCommand}
apply_patch <<PATCH
${real}
PATCH`;
  assert.deepEqual(extractEditOperations(tool('exec_command', { cmd: fixtureThenReal })), [
    { path: 'real.js', additions: 1, deletions: 1 },
  ]);

  const shadowedInput = [
    'function apply_patch(value) { return value; }',
    `const patch = ${JSON.stringify(fake)};`,
    'apply_patch(patch);',
  ].join('\n');
  assert.deepEqual(extractEditOperations(tool('exec', { input: shadowedInput })), []);
});

test('wrapped patch binding respects shell shadows, reassignment, and JavaScript scope', () => {
  const fake = `*** Begin Patch
*** Update File: fake.js
@@
-old
+fake
*** End Patch`;
  const real = `*** Begin Patch
*** Update File: real.js
@@
-old
+real
*** End Patch`;

  for (const declaration of [
    'apply_patch() { cat; }',
    'function apply_patch { cat; }',
  ]) {
    const cmd = `${declaration}
apply_patch <<PATCH
${fake}
PATCH`;
    assert.deepEqual(extractEditOperations(tool('exec_command', { cmd })), []);
  }

  const explicitCommand = `apply_patch() { cat; }
command apply_patch <<PATCH
${real}
PATCH`;
  assert.deepEqual(extractEditOperations(tool('exec_command', {
    cmd: explicitCommand,
  })), [
    { path: 'real.js', additions: 1, deletions: 1 },
  ]);

  const reassigned = [
    `let patch = ${JSON.stringify(fake)};`,
    `patch = ${JSON.stringify(real)};`,
    'await tools.apply_patch(patch);',
  ].join('\n');
  assert.deepEqual(extractEditOperations(tool('exec', { input: reassigned })), [
    { path: 'real.js', additions: 1, deletions: 1 },
  ]);

  const scoped = [
    'const patch = "*** Begin Patch\\n*** Update File: fake.js\\n@@\\n-old\\n+fake\\n*** End Patch";',
    'function fixture() { const patch = "*** Begin Patch\\n*** Update File: real.js\\n@@\\n-old\\n+real\\n*** End Patch"; return patch; }',
    'await tools.apply_patch(patch);',
  ].join('\n');
  assert.deepEqual(extractEditOperations(tool('exec', { input: scoped })), [
    { path: 'fake.js', additions: 1, deletions: 1 },
  ]);
});

test('wrapped patch parsing supports nested shell and template interpolation invocations', () => {
  const patch = `*** Begin Patch
*** Update File: real.js
@@
-old
+new
*** End Patch`;
  const nestedShell = `bash -lc 'apply_patch <<PATCH
${patch}
PATCH
'`;
  assert.deepEqual(extractEditOperations(tool('exec_command', { cmd: nestedShell })), [
    { path: 'real.js', additions: 1, deletions: 1 },
  ]);

  const interpolatedInput = [
    `const patch = ${JSON.stringify(patch)};`,
    'const result = `${await tools.apply_patch(patch)}`;',
  ].join('\n');
  assert.deepEqual(extractEditOperations(tool('exec', { input: interpolatedInput })), [
    { path: 'real.js', additions: 1, deletions: 1 },
  ]);
});

test('wrapped patch parsing rejects non-executable shell and JavaScript lookalikes', () => {
  const patch = `*** Begin Patch
*** Update File: fake.js
@@
-old
+new
*** End Patch`;
  for (const cmd of [
    `# apply_patch <<PATCH
${patch}
PATCH`,
    `echo apply_patch <<PATCH
${patch}
PATCH`,
    `echo 'apply_patch <<PATCH
${patch}
PATCH
'`,
  ]) {
    assert.deepEqual(extractEditOperations(tool('exec_command', { cmd })), []);
  }

  for (const invocation of [
    'mytools.apply_patch(patch);',
    'other_tools.apply_patch(patch);',
    'foo.tools.apply_patch(patch);',
    'const matcher = /apply_patch(patch)/;',
    'const matcher = /tools.apply_patch(patch)/;',
    'tools.apply_patch(patch && real);',
    'tools.apply_patch(patch.replace("fake.js", "real.js"));',
    'tools.apply_patch(patch + real);',
  ]) {
    const input = [
      `const patch = ${JSON.stringify(patch)};`,
      `const real = ${JSON.stringify(patch.replace('fake.js', 'real.js'))};`,
      invocation,
    ].join('\n');
    assert.deepEqual(extractEditOperations(tool('exec', { input })), []);
  }
});

test('wrapped patch extraction remains bounded for many invocations', { timeout: 5_000 }, () => {
  const patch = `*** Begin Patch
*** Update File: bounded.js
@@
-old
+new
*** End Patch`;
  const input = [
    `const patch = ${JSON.stringify(patch)};`,
    ...Array.from({ length: 16_000 }, () => 'await tools.apply_patch(patch);'),
  ].join('\n');
  const operations = extractEditOperations(tool('exec', { input }));
  assert.equal(operations.length, 1_000);
  assert.equal(operations.every((operation) => operation.path === 'bounded.js'), true);
});

test('unified diff headers are recognized only outside hunk bodies', () => {
  assert.deepEqual(parsePatch(`diff --git a/src/a.js b/src/a.js
--- a/src/a.js
+++ b/src/a.js
@@ -1,2 +1,2 @@
--- deleted content
+++ added content
 keep`), [{
    path: 'src/a.js',
    additions: 1,
    deletions: 1,
  }]);
  assert.deepEqual(parsePatch(`--- /dev/null
+++ b/src/new.js
@@ -0,0 +1 @@
+new`), [{
    path: 'src/new.js',
    additions: 1,
    deletions: 0,
  }]);
  assert.deepEqual(parsePatch(`--- a/src/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-gone`), [{
    path: 'src/gone.js',
    additions: 0,
    deletions: 1,
  }]);
  assert.deepEqual(parsePatch(`diff --git a/gone.bin b/gone.bin
deleted file mode 100644
Binary files a/gone.bin and /dev/null differ
--- a/gone.bin
+++ /dev/null`), [{
    path: 'gone.bin',
    additions: 0,
    deletions: 0,
    estimated: true,
  }]);
  assert.deepEqual(parsePatch(`diff --git a/src/timed.js b/src/timed.js
--- a/src/timed.js	2026-07-29 12:00:00.000000000 +0200
+++ b/src/timed.js	2026-07-30 12:00:00.000000000 +0200
@@ -1 +1 @@
-old
+new`), [{
    path: 'src/timed.js',
    additions: 1,
    deletions: 1,
  }]);
  assert.deepEqual(parsePatch(`--- a/src/one.js
+++ b/src/one.js
@@ -1 +1 @@
-one
+ONE
--- a/src/two.js
+++ b/src/two.js
@@ -1 +1 @@
-two
+TWO`), [
    { path: 'src/one.js', additions: 1, deletions: 1 },
    { path: 'src/two.js', additions: 1, deletions: 1 },
  ]);
  assert.deepEqual(parsePatch(`diff --git "a/name\\tpart.js" "b/name\\tpart.js"
--- "a/name\\tpart.js"
+++ "b/name\\tpart.js"
@@ -1 +1 @@
-old
+new`), [{
    path: 'name\tpart.js',
    additions: 1,
    deletions: 1,
  }]);
  assert.deepEqual(parsePatch(`diff --git a/gone.bin b/gone.bin
deleted file mode 100644
Binary files a/gone.bin and /dev/null differ`), [{
    path: 'gone.bin',
    additions: 0,
    deletions: 0,
    estimated: true,
  }]);
  assert.deepEqual(parsePatch(`diff --git a/dir b/file.js b/dir b/file.js
--- a/dir b/file.js
+++ b/dir b/file.js
@@ -1 +1 @@
-old
+new`), [{
    path: 'dir b/file.js',
    additions: 1,
    deletions: 1,
  }]);
  assert.deepEqual(parsePatch(`diff --git a/dir b/file.js b/new b/file.js
similarity index 100%
rename from dir b/file.js
rename to new b/file.js`), [{
    path: 'new b/file.js',
    additions: 0,
    deletions: 0,
  }]);
  const backslashPatch = String.raw`diff --git "a/back\\slash.js" "b/back\\slash.js"
--- "a/back\\slash.js"
+++ "b/back\\slash.js"
@@ -1 +1 @@
-old
+new`;
  assert.deepEqual(parsePatch(backslashPatch), [{
    path: 'back\\slash.js',
    additions: 1,
    deletions: 1,
  }]);
  assert.deepEqual(extractEditOperations(tool('apply_patch', {
    patch: backslashPatch,
  })), [{
    path: 'back\\slash.js',
    additions: 1,
    deletions: 1,
  }]);
});

test('extractEditOperations understands Cursor StrReplace and Write fields', () => {
  assert.deepEqual(extractEditOperations({
    kind: 'tool',
    tool: {
      name: 'StrReplace',
      args: {
        path: '/workspace/project/card.js',
        old_string: 'old',
        new_string: 'new\nline',
      },
    },
  }, '/workspace/project'), [{
    path: 'card.js',
    additions: 2,
    deletions: 1,
  }]);
  assert.deepEqual(extractEditOperations({
    kind: 'tool',
    tool: {
      name: 'Write',
      args: {
        path: '/workspace/project/new.js',
        contents: 'one\ntwo\n',
      },
    },
  }, '/workspace/project'), [{
    path: 'new.js',
    additions: 2,
    deletions: 0,
    estimated: true,
  }]);
  assert.deepEqual(extractEditOperations(tool('Edit', {
    file_path: `/workspace/project/${'x'.repeat(5000)}.js`,
    old_string: 'old',
    new_string: 'new',
  }), '/workspace/project'), []);
});

test('replacement diffs count only changed lines and normalize project-relative paths', () => {
  assert.deepEqual(diffLineCounts('keep\nold\nsame', 'keep\nnew\nsame'), {
    additions: 1,
    deletions: 1,
    estimated: false,
  });
  assert.deepEqual(extractEditOperations(tool('Edit', {
    file_path: '/workspace/project/src/a.js',
    old_string: 'keep\nold\nsame',
    new_string: 'keep\nnew\nsame',
  }), '/workspace/project'), [{ path: 'src/a.js', additions: 1, deletions: 1 }]);
  assert.deepEqual(extractEditOperations(tool('Edit', {
    file_path: 'a/src.js',
    old_string: 'old',
    new_string: 'new',
  })), [{ path: 'a/src.js', additions: 1, deletions: 1 }]);
  assert.deepEqual(parsePatch(`*** Begin Patch
*** Update File: b/src.js
@@
-old
+new
*** End Patch`), [{ path: 'b/src.js', additions: 1, deletions: 1 }]);
});

test('patch moves do not create phantom files and unknown delete size is explicit', () => {
  assert.deepEqual(parsePatch(`*** Begin Patch
*** Update File: old.js
*** Move to: new.js
@@
-old
+new
*** End Patch`), [{ path: 'new.js', additions: 1, deletions: 1 }]);
  assert.deepEqual(parsePatch(`*** Begin Patch
*** Delete File: gone.js
*** End Patch`), [{ path: 'gone.js', additions: 0, deletions: 0, estimated: true }]);
});

test('whole-file writes and inserts are visibly estimated', () => {
  assert.deepEqual(
    extractEditOperations(tool('Write', { path: 'src/new.js', content: 'one\ntwo' })),
    [{ path: 'src/new.js', additions: 2, deletions: 0, estimated: true }],
  );
  assert.deepEqual(
    extractEditOperations(tool('str_replace_editor', { command: 'insert', path: 'src/a.js', new_str: 'one' })),
    [{ path: 'src/a.js', additions: 1, deletions: 0, estimated: true }],
  );
});

test('priceSession applies fresh input, cache, and output rates separately', () => {
  const priced = priceSession(makeSession(), pricing);
  // 600k fresh * $1.75 + 400k cache * $0.175 + 100k output * $14
  assert.equal(priced.total, 2.52);
  assert.equal(priced.rate.id, 'gpt-5.3-codex');
});

test('Claude Fable 5 and Mythos 5 remain distinct aliases with aligned rates', () => {
  const fable = priceSession(makeSession({
    source: 'claude-code',
    model: 'claude-fable-5',
  }), pricing);
  const mythos = priceSession(makeSession({
    source: 'claude-code',
    model: 'claude-mythos-5',
  }), pricing);
  assert.equal(fable.rate.id, 'claude-fable-5');
  assert.equal(mythos.rate.id, 'claude-mythos-5');
  assert.equal(fable.total, 11.4);
  assert.equal(mythos.total, fable.total);
});

test('pricing cannot bill more cached input than the recorded input total', () => {
  const priced = priceSession(makeSession({
    usage: [{
      ts: '2026-07-18T10:00:00Z',
      model: 'gpt-5.3-codex',
      input: 10,
      output: 0,
      cacheRead: 20,
      cacheWrite: 30,
    }],
  }), pricing);
  assert.equal(priced.billableTokens, 10);
  assert.equal(priced.cacheRead, 10);
  assert.equal(priced.cacheWrite, 0);
  assert.equal(priced.freshInput, 0);
});

test('missing cache-read pricing is rejected and cannot fall back to the full input rate', () => {
  const customPricing = {
    currency: 'USD',
    models: [{ id: 'custom-model', models: ['custom-model'], input: 10, output: 20 }],
  };
  assert.equal(
    validatePricing(customPricing).some((issue) => issue.includes('cacheRead')),
    true,
  );
  const priced = priceSession(makeSession({
    model: 'custom-model',
    stats: {
      tokensIn: 1_000_000,
      tokensOut: 0,
      tokensCacheRead: 1_000_000,
    },
  }), customPricing);
  assert.equal(priced.total, 0);
  assert.equal(priced.cacheRead, 1_000_000);
});

test('non-finite calculated costs remain unpriced', () => {
  const priced = priceSession(makeSession({
    model: 'overflow-model',
    stats: {
      tokensIn: Number.MAX_SAFE_INTEGER,
      tokensOut: 0,
      tokensCacheRead: 0,
    },
  }), {
    currency: 'USD',
    models: [{
      id: 'overflow-model',
      models: ['overflow-model'],
      input: Number.MAX_VALUE,
      output: 0,
    }],
  });
  assert.equal(priced.total, null);
  assert.equal(priced.pricedTokens, 0);
  assert.equal(priced.unpricedTokens, Number.MAX_SAFE_INTEGER);
});

test('Gemini Standard text usage uses source-scoped API-equivalent pricing', () => {
  const priced = priceSession(makeSession({
    source: 'gemini',
    model: 'gemini-3-flash-preview',
    stats: { tokensIn: 1_000_000, tokensOut: 100_000, tokensCacheRead: 400_000 },
  }), pricing);
  // 600k fresh * $0.50 + 400k cache * $0.05 + 100k output * $3.00
  assert.equal(priced.total, 0.62);
  assert.equal(priced.rate.id, 'gemini-3-flash-preview');
  assert.equal(priceSession(makeSession({
    source: 'codex',
    model: 'gemini-3-flash-preview',
  }), pricing).total, null);
});

test('per-turn pricing selects models and effective dates without guessing unknown usage', () => {
  const datedPricing = {
    currency: 'USD',
    models: [
      { id: 'model-a-old', models: ['model-a'], effectiveTo: '2026-01-01', input: 1, output: 1 },
      { id: 'model-a-new', models: ['model-a'], effectiveFrom: '2026-01-01', input: 2, output: 2 },
      { id: 'model-b', models: ['model-b'], input: 3, output: 3 },
    ],
  };
  const priced = priceSession(makeSession({
    usage: [
      { ts: '2025-12-31T12:00:00Z', model: 'model-a', input: 1_000_000, output: 0 },
      { ts: '2026-02-01T12:00:00Z', model: 'model-a', input: 1_000_000, output: 0 },
      { ts: '2026-02-01T12:01:00Z', model: 'model-b', input: 1_000_000, output: 0 },
      { ts: '2026-02-01T12:02:00Z', model: 'unknown', input: 1_000_000, output: 0 },
    ],
  }), datedPricing);

  assert.equal(priced.total, 6);
  assert.equal(priced.isPartial, true);
  assert.equal(priced.billableTokens, 4_000_000);
  assert.equal(priced.pricedTokens, 3_000_000);
  assert.deepEqual(priced.rates.map((rate) => rate.id), ['model-a-old', 'model-a-new', 'model-b']);
});

test('model summaries preserve every effective pricing period', () => {
  const datedPricing = {
    currency: 'USD',
    models: [
      { id: 'model-a-old', models: ['model-a'], effectiveTo: '2026-01-01', input: 1, output: 1 },
      { id: 'model-a-new', models: ['model-a'], effectiveFrom: '2026-01-01', input: 2, output: 2 },
    ],
  };
  const stats = buildStats([makeSession({
    model: 'model-a',
    usage: [
      { ts: '2025-12-31T12:00:00Z', model: 'model-a', input: 1_000_000, output: 0 },
      { ts: '2026-02-01T12:00:00Z', model: 'model-a', input: 1_000_000, output: 0 },
    ],
    stats: { tokensIn: 2_000_000, tokensOut: 0, tokensCacheRead: 0 },
  })], { days: Infinity, pricing: datedPricing });
  assert.equal(stats.cost.total, 3);
  assert.equal(stats.models[0].rate, null);
  assert.equal(stats.models[0].rateMode, 'mixed');
  assert.deepEqual(stats.models[0].rates.map((rate) => rate.id), ['model-a-old', 'model-a-new']);
});

test('cache-write duration tiers are priced independently', () => {
  const tieredPricing = {
    currency: 'USD',
    models: [{
      id: 'tiered',
      models: ['tiered'],
      input: 1,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2,
      cacheWrite5m: 2,
      cacheWrite1h: 4,
    }],
  };
  const priced = priceSession(makeSession({
    usage: [{
      ts: '2026-07-18T10:00:00Z',
      model: 'tiered',
      input: 1_000_000,
      output: 0,
      cacheRead: 100_000,
      cacheWrite: 500_000,
      cacheWrite5m: 200_000,
      cacheWrite1h: 300_000,
    }],
  }), tieredPricing);
  assert.equal(priced.total, 2.01);
});

test('buildStats derives impact, churn, corrections, rework, latency, and abandonment', () => {
  const first = makeSession({
    id: 'first',
    events: [
      { kind: 'user', ts: '2026-07-18T10:00:00.000Z', text: 'Build it' },
      tool('Edit', { file_path: 'src/a.js', old_string: 'old', new_string: 'new\nline' }),
      { kind: 'user', ts: '2026-07-18T10:00:06.000Z', text: "No, that's wrong; keep the old export." },
      tool('Edit', { file_path: 'src/a.js', old_string: 'new', new_string: 'fixed' }, '2026-07-18T10:00:07.000Z'),
      { kind: 'assistant', ts: '2026-07-18T10:00:10.000Z', text: 'Done' },
    ],
  });
  const second = makeSession({
    id: 'second',
    source: 'claude-code',
    model: 'claude-opus-4-8',
    events: [
      { kind: 'user', ts: '2026-07-18T11:00:00.000Z', text: 'Adjust it' },
      tool('Write', { path: 'src/a.js', content: 'replacement\ncontent' }, '2026-07-18T11:00:04.000Z'),
    ],
  });
  const stats = buildStats([first, second], { days: 2, pricing });

  assert.equal(stats.totals.edits, 3);
  assert.equal(stats.totals.filesTouched, 1);
  assert.equal(stats.workflow.reworkLoops, 1);
  assert.equal(stats.workflow.corrections, 1);
  assert.equal(stats.workflow.abandoned, 1);
  assert.equal(stats.workflow.medianTimeToFirstEditMs, 3500);
  assert.equal(stats.impact.files[0].sessions, 2);
  assert.equal(stats.impact.files[0].churn, 2);
  assert.equal(stats.scoreboard.length, 2);
  assert.equal(stats.scoreboard.find((r) => r.source === 'codex').medianToolLatencyMs, 2000);
  assert.equal(stats.cost.tokenCoverage, 1);
});

test('future timestamps cannot contaminate admitted-session analytics', () => {
  const stats = buildStats([makeSession({
    startedAt: '2026-07-20T10:00:00Z',
    endedAt: '2100-01-01T00:00:02Z',
    events: [
      { kind: 'user', ts: '2026-07-20T10:00:00Z', text: 'Inspect it' },
      tool('Read', {}, '2026-07-20T10:01:00Z', {
        resultTs: '2026-07-20T10:01:01Z',
      }),
      tool('Edit', {
        file_path: 'future.js',
        old_string: 'old',
        new_string: 'new',
      }, '2100-01-01T00:00:00Z', {
        resultTs: '2100-01-01T00:00:01Z',
        confirmed: true,
      }),
    ],
    usage: [
      {
        ts: '2026-07-20T10:01:00Z',
        model: 'gpt-5.3-codex',
        input: 100,
        output: 10,
        cacheRead: 20,
        cacheWrite: 0,
      },
      {
        ts: '2100-01-01T00:00:00Z',
        model: 'gpt-5.3-codex',
        input: 1_000_000,
        output: 100_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ],
    stats: {
      tokensIn: 1_000_100,
      tokensOut: 100_010,
      tokensCacheRead: 20,
      messages: 1,
      toolCounts: { Read: 1, Edit: 1 },
    },
  })], {
    days: 30,
    pricing,
    now: Date.parse('2026-07-30T12:00:00Z'),
  });

  assert.equal(stats.totals.toolCalls, 1);
  assert.equal(stats.totals.edits, 0);
  assert.equal(stats.totals.tokensIn, 100);
  assert.equal(stats.totals.tokensOut, 10);
  assert.equal(stats.records.activeDays, 1);
  assert.equal(stats.records.busiestDay.date, '2026-07-20');
  assert.equal(stats.workflow.abandoned, 1);
  assert.equal(stats.cost.pricedTokens, 110);
  assert.equal(stats.cost.unpricedTokens, 0);
  assert.equal(stats.cost.tokenCoverage, 1);
  assert.equal(stats.impact.files.length, 0);
});

test('large admitted latency samples do not overflow argument limits', { timeout: 10_000 }, () => {
  const events = Array.from({ length: 130_000 }, () => tool('Read', {}));
  const stats = buildStats([makeSession({
    events,
    stats: {
      tokensIn: 0,
      tokensOut: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      toolCounts: { Read: events.length },
    },
  })], { days: Infinity, pricing: null });
  assert.equal(stats.scoreboard[0].samples.toolLatencies, events.length);
  assert.equal(stats.scoreboard[0].medianToolLatencyMs, 2_000);
});

test('failed and unfinished edit calls do not count as confirmed code impact', () => {
  const session = makeSession({
    events: [
      tool('Edit', { file_path: 'src/confirmed.js', old_string: 'old', new_string: 'new' }),
      tool('Edit', { file_path: 'src/failed.js', old_string: 'old', new_string: 'new' }, '2026-07-18T10:00:06.000Z', {
        result: 'failed',
        isError: true,
        resultTs: '2026-07-18T10:00:07.000Z',
      }),
      tool('Write', { path: 'src/pending.js', content: 'new' }, '2026-07-18T10:00:08.000Z', {
        result: null,
        resultTs: null,
      }),
    ],
  });
  const stats = buildStats([session], { days: 1, pricing });

  assert.equal(stats.totals.attemptedEdits, 3);
  assert.equal(stats.totals.edits, 1);
  assert.equal(stats.totals.editCalls, 1);
  assert.equal(stats.totals.failedEdits, 1);
  assert.equal(stats.totals.unconfirmedEdits, 1);
  assert.equal(stats.totals.filesTouched, 1);
  assert.equal(stats.impact.files[0].path, 'src/confirmed.js');
});

test('file impact is isolated by project and uses unique session keys', () => {
  const edit = () => [
    tool('Edit', { file_path: 'src/index.js', old_string: 'old', new_string: 'new' }),
  ];
  const projectOneFirst = makeSession({
    id: 'duplicate',
    key: 'codex:key-one',
    cwd: '/workspace/project-one',
    events: edit(),
  });
  const projectOneSecond = makeSession({
    id: 'duplicate',
    key: 'codex:key-two',
    cwd: '/workspace/project-one',
    events: edit(),
  });
  const projectTwo = makeSession({
    id: 'duplicate',
    key: 'codex:key-three',
    cwd: '/workspace/project-two',
    events: edit(),
  });
  const stats = buildStats([projectOneFirst, projectOneSecond, projectTwo], { days: 1, pricing });

  assert.equal(stats.totals.filesTouched, 2);
  const projectOne = stats.impact.files.find((file) => file.project === '/workspace/project-one');
  const projectTwoRow = stats.impact.files.find((file) => file.project === '/workspace/project-two');
  assert.equal(projectOne.sessions, 2);
  assert.equal(projectOne.edits, 2);
  assert.equal(projectTwoRow.sessions, 1);
  assert.equal(projectTwoRow.edits, 1);
});

test('project identity is platform-neutral and normalizes Windows paths', () => {
  const first = makeSession({
    key: 'codex:windows-one',
    cwd: 'C:\\Work\\RunLume',
    events: [tool('Edit', {
      file_path: 'SRC\\index.js',
      old_string: 'old',
      new_string: 'new',
    })],
  });
  const second = makeSession({
    key: 'codex:windows-two',
    cwd: 'c:/work/runlume/',
    events: [tool('Edit', {
      file_path: 'src/index.js',
      old_string: 'old',
      new_string: 'new',
    })],
  });
  const stats = buildStats([first, second], { days: 1, pricing });

  assert.equal(stats.totals.filesTouched, 1);
  assert.equal(stats.impact.files[0].project, 'C:/Work/RunLume');
  assert.equal(stats.impact.files[0].path, 'SRC/index.js');
  assert.equal(stats.impact.files[0].sessions, 2);
  assert.equal(stats.impact.files[0].edits, 2);
});

test('POSIX project identity remains case-sensitive', () => {
  const upper = makeSession({ key: 'codex:posix-one', cwd: '/work/RunLume', events: [tool('Edit', { file_path: 'src/index.js', old_string: 'old', new_string: 'new' })] });
  const lower = makeSession({ key: 'codex:posix-two', cwd: '/work/runlume', events: [tool('Edit', { file_path: 'src/index.js', old_string: 'old', new_string: 'new' })] });
  const stats = buildStats([upper, lower], { days: 1, pricing });

  assert.equal(stats.totals.filesTouched, 2);
});

test('unknown models stay explicitly unpriced', () => {
  const stats = buildStats([makeSession({ model: 'vendor-mystery-9' })], { days: 1, pricing });
  assert.equal(stats.cost.pricedSessions, 0);
  assert.equal(stats.cost.unpricedSessions, 1);
  assert.equal(stats.cost.sessions[0].apiCost, null);
  assert.equal(stats.cost.tokenCoverage, 0);
  assert.equal(stats.cost.isPartial, true);
});

test('provider inference keeps agent source separate from model provider', () => {
  assert.equal(inferProvider('gpt-5.3-codex', 'cursor'), 'openai');
  assert.equal(inferProvider('claude-sonnet-4-6', 'cursor'), 'anthropic');
  assert.equal(inferProvider('gemini-3-flash-preview', 'cursor'), 'google');
  assert.equal(inferProvider('llama3.2', 'cursor'), 'meta');
  assert.equal(inferProvider('nvidia/nemotron', 'api-log'), 'nvidia');
  assert.equal(inferProvider('kimi-k3', 'api-log'), 'moonshot');
  assert.equal(inferProvider('glm-5.2', 'api-log'), 'zhipu');
  assert.equal(inferProvider('qwen-3.6', 'api-log'), 'alibaba');
  assert.equal(inferProvider('mistral-large', 'api-log'), 'mistral');
  assert.equal(inferProvider('llama3.2', 'api-log', 'local'), 'local');
  assert.equal(inferProvider('openai/gpt-oss-20b', 'api-log', 'local'), 'local');
  assert.equal(inferProvider(null, 'hermes'), 'unknown');
});

test('provider analytics aggregate cross-agent usage and never price declared local sessions', () => {
  const local = makeSession({
    id: 'local-session',
    source: 'api-log',
    provider: 'local',
    runtime: 'LM Studio',
    model: 'gpt-5.3-codex',
    usage: [{
      ts: '2026-07-18T10:00:01.000Z',
      model: 'gpt-5.3-codex',
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
    }],
    stats: { tokensIn: 100, tokensOut: 20, tokensCacheRead: 0 },
  });
  const cursorClaude = makeSession({
    id: 'cursor-claude',
    source: 'cursor',
    model: 'claude-sonnet-4-6',
    usage: [{
      ts: '2026-07-18T10:00:01.000Z',
      model: 'claude-sonnet-4-6',
      input: 200,
      output: 40,
      cacheRead: 20,
      cacheWrite: 0,
    }],
    stats: { tokensIn: 200, tokensOut: 40, tokensCacheRead: 20 },
  });

  assert.equal(priceSession(local, pricing).total, null);
  const stats = buildStats([local, cursorClaude], { days: Infinity, pricing });
  const localProvider = stats.providers.find((provider) => provider.provider === 'local');
  const anthropicProvider = stats.providers.find((provider) => provider.provider === 'anthropic');
  assert.equal(localProvider.sessions, 1);
  assert.equal(localProvider.apiCost, null);
  assert.deepEqual(localProvider.sources, ['api-log']);
  assert.equal(anthropicProvider.sessions, 1);
  assert.deepEqual(anthropicProvider.sources, ['cursor']);
  assert.ok(anthropicProvider.apiCost > 0);
});

test('daily usage is attributed to each usage timestamp instead of the session start', () => {
  const stats = buildStats([makeSession({
    startedAt: '2026-07-18T10:00:00Z',
    endedAt: '2026-07-19T10:00:00Z',
    usage: [
      { ts: '2026-07-18T10:00:00Z', model: 'gpt-5.3-codex', input: 100, output: 10 },
      { ts: '2026-07-19T10:00:00Z', model: 'gpt-5.3-codex', input: 200, output: 20 },
    ],
  })], { days: Infinity, pricing });

  assert.equal(stats.perDay.find((day) => day.date === '2026-07-18').sessions, 1);
  assert.equal(stats.perDay.find((day) => day.date === '2026-07-18').tokensIn, 100);
  assert.equal(stats.perDay.find((day) => day.date === '2026-07-19').sessions, 0);
  assert.equal(stats.perDay.find((day) => day.date === '2026-07-19').tokensIn, 200);
});

test('finite reporting windows expose the calendar-series start, not an older session start', () => {
  const now = new Date();
  const old = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const session = makeSession({
    startedAt: old,
    endedAt: now.toISOString(),
    events: [
      { kind: 'user', ts: old, text: 'Start' },
      { kind: 'assistant', ts: now.toISOString(), text: 'Done' },
    ],
  });
  const stats = buildStats([session], { days: 30, pricing });
  assert.equal(stats.window.from, stats.perDay[0].date);
  assert.notEqual(stats.window.from, dayKey(old));
  assert.equal(stats.window.spanDays, 30);
});

test('finite reporting windows use calendar arithmetic and always emit the requested days', () => {
  const now = new Date(2026, 10, 2, 12, 0, 0);
  const start = calendarWindowStart(now, 30);
  const expected = new Date(now);
  expected.setHours(0, 0, 0, 0);
  expected.setDate(expected.getDate() - 29);
  assert.equal(start.getTime(), expected.getTime());

  const stats = buildStats([], { days: 30, pricing: null, now });
  assert.equal(stats.perDay.length, 30);
  assert.equal(stats.window.from, dayKey(start));
  assert.equal(stats.window.to, dayKey(now));
  assert.match(stats.window.mode, /latest valid activity/);
});

test('all-history series stays sparse for ancient timestamps', () => {
  const stats = buildStats([
    makeSession({
      id: 'ancient',
      startedAt: '1900-01-01T00:00:00Z',
      endedAt: '1900-01-01T00:01:00Z',
      stats: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 },
    }),
    makeSession({
      id: 'current',
      startedAt: '2026-07-18T00:00:00Z',
      endedAt: '2026-07-18T00:01:00Z',
      stats: { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 },
    }),
  ], { days: Infinity, pricing });
  assert.equal(stats.window.seriesMode, 'active-days');
  assert.equal(stats.perDay.length, 2);
  assert.ok(stats.window.spanDays > 40_000);
});

test('pricing validation rejects malformed aliases and future model versions remain unpriced', () => {
  assert.deepEqual(validatePricing(pricing), []);
  assert.ok(validatePricing({ currency: 'usd', models: [{ id: 'bad', models: ['['], input: -1 }] }).length >= 3);
  assert.ok(validatePricing({
    currency: 'USD',
    models: [{ id: 'unsafe', models: ['safe-model'], allowDatedSuffix: 'yes', input: 1, output: 1 }],
  }).some((issue) => issue.includes('must be a boolean')));
  assert.ok(validatePricing({
    currency: 'USD',
    effectiveFrom: '2026-02-30',
    models: [{ id: 'dated', models: ['dated'], input: 1, output: 1 }],
  }).some((issue) => issue.includes('valid YYYY-MM-DD')));
  assert.ok(validatePricing({
    currency: 'USD',
    models: [
      { id: 'first', models: ['overlap-model'], effectiveTo: '2026-08-01', input: 1, output: 1 },
      { id: 'second', models: ['overlap-model'], effectiveFrom: '2026-07-01', input: 2, output: 2 },
    ],
  }).some((issue) => issue.includes('overlaps')));
  assert.deepEqual(validatePricing({
    currency: 'USD',
    models: [
      { id: 'first', models: ['adjacent-model'], effectiveTo: '2026-08-01', input: 1, output: 1, cacheRead: 0 },
      { id: 'second', models: ['adjacent-model'], effectiveFrom: '2026-08-01', input: 2, output: 2, cacheRead: 0 },
      { id: 'codex-only', source: 'codex', models: ['scoped-model'], input: 1, output: 1, cacheRead: 0 },
      { id: 'gemini-only', source: 'gemini', models: ['scoped-model'], input: 2, output: 2, cacheRead: 0 },
    ],
  }), []);
  assert.ok(validatePricing({
    currency: 'USD',
    models: [
      { id: 'global', models: ['global-model'], input: 1, output: 1 },
      { id: 'scoped', source: 'codex', models: ['global-model'], input: 2, output: 2 },
    ],
  }).some((issue) => issue.includes('overlaps')));
  assert.ok(validatePricing({
    currency: 'USD',
    models: [
      { id: 'dated-base', models: ['dated-model'], allowDatedSuffix: true, input: 1, output: 1 },
      { id: 'dated-exact', models: ['dated-model-20260729'], input: 2, output: 2 },
    ],
  }).some((issue) => issue.includes('overlaps')));
  assert.ok(validatePricing({
    currency: 'USD',
    models: [{ id: 'bad-source', source: '../codex', models: ['safe-model'], input: 1, output: 1 }],
  }).some((issue) => issue.includes('source identifier')));
  for (const model of ['claude-opus-4-9', 'claude-sonnet-4-7', 'claude-haiku-999']) {
    assert.equal(priceSession(makeSession({ source: 'claude-code', model }), pricing).total, null);
  }
});
