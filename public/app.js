/* RunLume frontend: metrics, trajectories, and Wrapped. */
function storageGet(name, key) {
  try { return globalThis[name]?.getItem(key) ?? null; }
  catch { return null; }
}
function storageSet(name, key, value) {
  try {
    globalThis[name]?.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

let state = {
  sessions: [],
  sources: [],
  roots: [],
  counts: {},
  diagnostics: {},
  sessionOutput: { total: 0, shown: 0, omitted: 0 },
  revision: '',
};
let stats = null;
let selected = null;
let sourceFilter = storageGet('localStorage', 'runlume-source') || 'all';
const TOKEN_STORAGE_KEY = 'runlume-token';
const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
const fragmentToken = fragment.get('token');
if (fragmentToken && /^[A-Za-z0-9_-]{32,}$/.test(fragmentToken)) {
  storageSet('sessionStorage', TOKEN_STORAGE_KEY, fragmentToken);
  try { history.replaceState(null, '', `${location.pathname}${location.search}`); }
  catch { /* the token is still kept in tab storage when available */ }
}
const apiToken = /^[A-Za-z0-9_-]{32,}$/.test(fragmentToken ?? '')
  ? fragmentToken
  : storageGet('sessionStorage', TOKEN_STORAGE_KEY);
const SOURCE_LABEL = { 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', gemini: 'Gemini', 'api-log': 'API & Local Logs', hermes: 'Hermes' };
const sourceLabel = (s) => (s === 'all' ? 'Agents' : SOURCE_LABEL[s] || s);
const sourceShort = { 'claude-code': 'Claude', cursor: 'Cursor', codex: 'Codex', gemini: 'Gemini', 'api-log': 'Imported', hermes: 'Hermes' };
const PROVIDER_LABEL = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  nvidia: 'NVIDIA',
  moonshot: 'Moonshot AI',
  zhipu: 'Zhipu AI',
  alibaba: 'Alibaba Cloud',
  meta: 'Meta',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  cohere: 'Cohere',
  xai: 'xAI',
  local: 'Local',
  unknown: 'Unknown',
};
const providerLabel = (provider) => PROVIDER_LABEL[provider] || provider;

const PLAN_STORAGE_KEY = 'runlume-plans';
const MAX_MONTHLY_PLAN_COST = 1_000_000;
const MAX_SAVED_PLANS = 100;
const DEFAULT_PLANS = {
  'claude-code': { name: 'Claude plan', monthlyCost: 0 },
  codex: { name: 'Codex plan', monthlyCost: 0 },
};

function loadPlanConfig() {
  let savedPlans = {};
  try { savedPlans = JSON.parse(storageGet('localStorage', PLAN_STORAGE_KEY) || '{}').plans || {}; }
  catch { /* use defaults */ }

  const plans = {};
  const sources = [...new Set([...Object.keys(DEFAULT_PLANS), ...Object.keys(savedPlans)])]
    .slice(0, MAX_SAVED_PLANS);
  for (const source of sources) {
    const fallback = DEFAULT_PLANS[source] || { name: `${sourceLabel(source)} plan`, monthlyCost: 0 };
    const saved = savedPlans[source] || {};
    const monthlyCost = Number(saved.monthlyCost ?? fallback.monthlyCost);
    plans[source] = {
      name: String(saved.name || fallback.name).slice(0, 80),
      monthlyCost: Number.isFinite(monthlyCost)
        ? Math.min(MAX_MONTHLY_PLAN_COST, Math.max(0, monthlyCost))
        : fallback.monthlyCost,
    };
  }
  return { plans };
}

let planConfig = loadPlanConfig();

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtNum = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  : String(Math.round(n));
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const countLabel = (n, singular, plural = `${singular}s`) =>
  `${fmtInt(n)} ${Number(n) === 1 ? singular : plural}`;
const fmtMoney = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  const digits = Math.abs(n) < 0.01 && n !== 0 ? 4 : 2;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: stats?.cost?.currency || 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
};
const fmtPct = (n, digits = 1) => (n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`);
function fmtDur(ms) {
  if (ms == null || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}
const fmtHour = (h) => (h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`);
const parseDay = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDay = (k) => parseDay(k).toLocaleDateString([], { month: 'short', day: 'numeric' });
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_FULL = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

// ── data loading ─────────────────────────────────────────────────
function apiFetch(url, options = {}) {
  if (!apiToken) {
    const message = location.protocol === 'file:'
      ? 'Open this dashboard through the local server. Run npm start and use the authenticated URL printed in the terminal.'
      : 'The dashboard access token is missing. Restart the server and open the complete authenticated URL printed in the terminal.';
    return Promise.reject(new Error(message));
  }
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${apiToken}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('dashboard request timed out')), 60_000);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
  }
  return fetch(url, { ...options, headers, signal: controller.signal })
    .finally(() => clearTimeout(timeout));
}

let lastFingerprint = '';
let loading = false;
async function loadState(force = false) {
  if (loading) return;
  loading = true;
  const refresh = $('#refresh');
  refresh.disabled = true;
  refresh.setAttribute('aria-busy', 'true');
  try {
    const params = new URLSearchParams();
    if (sourceFilter !== 'all') params.set('source', sourceFilter);
    if (force) params.set('refresh', '1');
    const response = await apiFetch(`/api/dashboard${params.size ? `?${params}` : ''}`);
    if (!response.ok) throw new Error(`dashboard request failed (${response.status})`);
    const payload = await response.json();
    const availableSources = payload.sources ?? Object.keys(payload.counts ?? {});
    if (sourceFilter !== 'all' && !availableSources.includes(sourceFilter)) {
      sourceFilter = 'all';
      storageSet('localStorage', 'runlume-source', sourceFilter);
      loading = false;
      setTimeout(() => loadState(true), 0);
      return;
    }
    stats = payload.stats;
    state = {
      sessions: payload.sessions ?? [],
      sources: availableSources,
      roots: payload.roots ?? [],
      counts: payload.counts ?? {},
      diagnostics: payload.diagnostics ?? {},
      sessionOutput: payload.sessionOutput ?? {
        total: payload.sessions?.length ?? 0,
        shown: payload.sessions?.length ?? 0,
        omitted: 0,
      },
      revision: payload.revision ?? '',
    };
    $('#roots').textContent = state.roots.length
      ? state.roots.join('  ·  ')
      : 'no agent state directories found';
    $('#roots').setAttribute('role', 'status');
    renderSeg();
    const fingerprint = [
      sourceFilter,
      state.revision,
      stats.window?.to,
      stats.totals?.tokensIn,
      stats.totals?.tokensOut,
      stats.workflow?.abandoned,
      stats.cost?.total,
    ].join('|');
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (selected && !state.sessions.some((session) => session.key === selected)) selected = null;
    renderMain();
    renderTree();
  } catch (err) {
    $('#roots').textContent = `refresh failed · ${err instanceof Error ? err.message : String(err)}`;
    $('#roots').classList.add('load-error');
    $('#roots').setAttribute('role', 'alert');
  } finally {
    loading = false;
    refresh.disabled = false;
    refresh.removeAttribute('aria-busy');
    if (!$('#roots').textContent.startsWith('refresh failed')) {
      $('#roots').classList.remove('load-error');
      $('#roots').setAttribute('role', 'status');
    }
  }
}

// ── source switcher ──────────────────────────────────────────────
function renderSeg() {
  const seg = $('#seg');
  const sources = [...new Set([...(state.sources ?? []), ...Object.keys(state.counts)])].sort();
  if (!sources.length) { seg.innerHTML = ''; return; }
  const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
  const pill = (id, name, n) =>
    `<button role="tab" aria-selected="${sourceFilter === id}" class="${sourceFilter === id ? 'active' : ''}" data-src="${esc(id)}">${esc(name)} <span class="n">${n}</span></button>`;
  seg.innerHTML =
    pill('all', 'All', total) +
    sources.map((s) => pill(s, sourceLabel(s), state.counts[s] ?? 0)).join('');
  seg.title = state.roots.join('\n');
  const buttons = [...seg.querySelectorAll('button')];
  for (const b of buttons) {
    b.tabIndex = sourceFilter === b.dataset.src ? 0 : -1;
    b.addEventListener('click', async () => {
      if (sourceFilter === b.dataset.src) return;
      sourceFilter = b.dataset.src;
      storageSet('localStorage', 'runlume-source', sourceFilter);
      selected = null;
      await loadState(true);
      [...seg.querySelectorAll('button')].find((button) => button.dataset.src === sourceFilter)?.focus();
    });
    b.addEventListener('keydown', (event) => {
      const current = buttons.indexOf(b);
      const targetIndex = event.key === 'Home' ? 0
        : event.key === 'End' ? buttons.length - 1
        : event.key === 'ArrowRight' ? (current + 1) % buttons.length
        : event.key === 'ArrowLeft' ? (current - 1 + buttons.length) % buttons.length
        : null;
      if (targetIndex == null) return;
      event.preventDefault();
      buttons[targetIndex].focus();
      buttons[targetIndex].click();
    });
  }
}

// ── tooltip ──────────────────────────────────────────────────────
const tip = () => $('#tooltip');
function showTip(html, x, y) {
  const t = tip();
  t.innerHTML = html;
  t.classList.add('on');
  moveTip(x, y);
}
function moveTip(x, y) {
  const t = tip();
  const r = t.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  t.style.left = `${Math.max(8, left)}px`;
  t.style.top = `${Math.max(8, top)}px`;
}
const hideTip = () => tip().classList.remove('on');

// ── sidebar: spawn tree ──────────────────────────────────────────
function renderTree() {
  const byId = new Map(state.sessions.map((s) => [s.key, s]));
  const byGroup = new Map();
  for (const s of state.sessions) {
    const key = `${s.source} · ${s.agent}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(s);
  }
  // newest activity first, both across groups and within them
  const groups = [...byGroup.entries()].sort(
    (a, b) => latest(b[1]).localeCompare(latest(a[1]))
  );
  let html = '';
  for (const [key, sessions] of groups) {
    html += `<section class="session-group" aria-label="${esc(key)} sessions"><div class="agent-name">${esc(key)}</div>`;
    const roots = sessions
      .filter((s) => !s.parent || !byId.has(s.parent))
      .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
    html += treeNodesHtml(roots, byId);
    html += '</section>';
  }
  $('#tree').innerHTML = html || '<div class="agent-name">no sessions</div>';
  function latest(sessions) {
    return sessions.reduce((m, s) => ((s.endedAt || '') > m ? s.endedAt : m), '');
  }
  for (const btn of document.querySelectorAll('.node-btn')) {
    btn.addEventListener('click', () => selectSession(btn.dataset.key));
  }
}

function nodeButtonHtml(s, isChild) {
  const isLive = s.endedAt && Date.now() - Date.parse(s.endedAt) < 3 * 60_000;
  const live = isLive ? '<span class="live">● live</span>' : '';
  const errs = s.stats.errors ? `<span class="err">${s.stats.errors} error${s.stats.errors === 1 ? '' : 's'}</span>` : '';
  const tools = Number.isFinite(s.stats.toolCallsTotal)
    ? s.stats.toolCallsTotal
    : Object.values(s.stats.toolCounts ?? {}).reduce((a, b) => a + Number(b || 0), 0);
  return `<button class="node-btn ${selected === s.key ? 'active' : ''}" data-key="${esc(s.key)}">
    <span class="node-label">${isChild ? '<span class="spawn-tag">↳ </span>' : ''}${esc(s.label)}</span>
    <span class="node-meta">${live}<span>${s.startedAt ? new Date(s.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}</span><span>${tools} ${tools === 1 ? 'tool' : 'tools'}</span>${errs}</span>
  </button>`;
}

function treeNodesHtml(roots, byId) {
  const stack = [...roots].reverse().map((session) => ({ session, isChild: false }));
  const visited = new Set();
  let html = '';
  while (stack.length) {
    const item = stack.pop();
    if (item.close) {
      html += item.close;
      continue;
    }
    const { session, isChild } = item;
    if (!session || visited.has(session.key)) continue;
    visited.add(session.key);
    const children = (session.children ?? [])
      .map((id) => byId.get(id))
      .filter((child) => child && !visited.has(child.key));
    html += `<div class="tree-node">${nodeButtonHtml(session, isChild)}`;
    if (!children.length) {
      html += '</div>';
      continue;
    }
    html += '<div class="tree-children">';
    stack.push({ close: '</div></div>' });
    for (let index = children.length - 1; index >= 0; index--) {
      stack.push({ session: children[index], isChild: true });
    }
  }
  return html;
}

// ── main: overview + charts ──────────────────────────────────────
function renderMain() {
  if (!state.sessions.length) {
    $('#main').innerHTML = `
      <section class="session-strip" aria-labelledby="session-strip-title">
        <div class="session-strip-head">
          <div><span class="section-kicker">Run stream</span><h2 id="session-strip-title">Recent sessions</h2></div>
          <small>Select a run to inspect its redacted trajectory</small>
        </div>
        <nav id="tree" aria-label="Session spawn tree"></nav>
      </section>
      <div class="empty-state">
        <h2>No sessions found</h2>
        <p>RunLume looked for agent transcripts and found none in this window.</p>
        <p>Run a supported agent CLI, import an explicit JSONL capture with
        <code>--import-dir &lt;path&gt;</code>, widen the window with
        <code>--all</code>, or try the demo: <code>npm run sample</code></p>
      </div>
      ${diagnosticBanner()}`;
    return;
  }
  const t = stats.totals;
  const freshIn = Math.max(0, t.tokensIn - t.cacheRead - (t.cacheWrite || 0));
  const totalTokens = freshIn + t.tokensOut;
  const windowLabel = stats.window.days ? `Last ${countLabel(stats.window.days, 'day')}` : 'All history';
  const topModel = stats.models[0]?.name;
  const completionRate = t.sessions
    ? Math.max(0, (t.sessions - stats.workflow.abandoned) / t.sessions)
    : 0;
  const toolReliability = t.toolCalls ? Math.max(0, (t.toolCalls - t.errors) / t.toolCalls) : 1;
  const latestActivity = state.sessions.reduce(
    (latest, session) => ((session.endedAt || '') > latest ? session.endedAt : latest),
    '',
  );

  $('#main').innerHTML = `
    <div class="dashboard-intro">
      <div>
        <span class="section-kicker">Local workspace analytics</span>
        <h2>Run intelligence</h2>
        <p>Observed activity, cost coverage, code impact, and workflow signals from your local transcripts.</p>
      </div>
      <div class="range-summary">
        <span>${esc(windowLabel)}</span>
        <strong>${latestActivity ? `Latest ${esc(fmtDate(latestActivity))}` : 'No dated activity'}</strong>
      </div>
    </div>
    <div class="overview-grid">
      <section class="hero" aria-labelledby="activity-title">
        <div class="hero-copy">
          <div class="eyebrow">${esc(sourceFilter === 'all' ? 'All observed agents' : sourceShort[sourceFilter] || sourceLabel(sourceFilter))}</div>
          <div class="big">${fmtNum(totalTokens)}<small>tokens processed</small></div>
          <div class="sub"><b>${fmtNum(freshIn)}</b> fresh input <span>·</span> <b>${fmtNum(t.tokensOut)}</b> output <span>·</span> <b>${fmtNum(t.cacheRead)}</b> cache-read</div>
          <div class="hero-context">
            <span><b>${fmtInt(stats.records.activeDays)}</b> active days</span>
            <span><b>${fmtInt(stats.records.streak)}</b> day streak</span>
            ${topModel ? `<span><b>${esc(topModel)}</b> top model</span>` : ''}
          </div>
        </div>
        <div class="hero-chart">
          <div class="chart-heading">
            <div><span class="section-kicker">Activity signal</span><h3 id="activity-title">Daily token flow</h3></div>
            <div class="legend" aria-label="Chart legend">
              <span class="chip"><span class="sw" style="background:var(--ser-in)"></span>Input</span>
              <span class="chip"><span class="sw" style="background:var(--ser-out)"></span>Output</span>
            </div>
          </div>
          <div class="chart-wrap" id="daily-chart"></div>
        </div>
      </section>
      <aside class="signal-stack" aria-label="Reporting signals">
        <article class="signal-card signal-cost">
          <span class="signal-label">API-equivalent cost</span>
          <strong>${fmtMoney(stats.cost.total)}</strong>
          <p>${fmtPct(stats.cost.tokenCoverage, 0)} of observed tokens priced</p>
          <div class="signal-meter" aria-hidden="true"><i style="width:${Math.max(2, stats.cost.tokenCoverage * 100)}%"></i></div>
        </article>
        <article class="signal-card">
          <span class="signal-label">Session completion</span>
          <strong>${fmtPct(completionRate, 0)}</strong>
          <p>${fmtInt(stats.workflow.abandoned)} abandoned of ${countLabel(t.sessions, 'session')}</p>
          <div class="signal-meter reliability" aria-hidden="true"><i style="width:${completionRate * 100}%"></i></div>
        </article>
      </aside>
    </div>
    <div class="cards">
      ${statTile('Sessions', fmtInt(t.sessions), countLabel(t.messages, 'message'))}
      ${statTile('Tool calls', fmtInt(t.toolCalls), stats.tools[0] ? `${esc(stats.tools[0].name)} leads` : '')}
      ${statTile('Code impact', `+${fmtNum(t.additions)}`, `−${fmtNum(t.deletions)} · ${countLabel(t.filesTouched, 'file')}${t.estimatedEdits ? ` · ${fmtInt(t.estimatedEdits)} estimated` : ''}${t.failedEdits ? ` · ${fmtInt(t.failedEdits)} failed` : ''}${t.unconfirmedEdits ? ` · ${fmtInt(t.unconfirmedEdits)} unfinished` : ''}`)}
      ${statTile('Sub-agents', fmtInt(t.spawns), 'spawned')}
      ${statTile('Tool reliability', fmtPct(toolReliability, 0), t.errors ? `${countLabel(t.errors, 'error')} observed` : 'no recorded errors')}
    </div>
    <section class="session-strip" aria-labelledby="session-strip-title">
      <div class="session-strip-head">
        <div><span class="section-kicker">Run stream</span><h2 id="session-strip-title">Recent sessions</h2></div>
        <small>Select a run to inspect its redacted trajectory</small>
      </div>
      <nav id="tree" aria-label="Session spawn tree"></nav>
    </section>
    ${diagnosticBanner()}
    ${stats.window.seriesTruncated ? `<div class="data-quality warn" role="status"><b>Chart range</b><span>Showing the latest ${countLabel(stats.perDay.length, 'active day')}; ${countLabel(stats.window.omittedActiveDays, 'earlier active day')} remain included in totals.</span></div>` : ''}
    <div class="panel feature-panel" id="cost-intelligence"></div>
    <div class="panel feature-panel">
      <h2>Parsed code impact <span class="note">· reported edit operations</span></h2>
      <div class="impact-summary">
        <div><strong class="add">+${fmtInt(t.additions)}</strong><span>lines added</span></div>
        <div><strong class="del">−${fmtInt(t.deletions)}</strong><span>lines removed</span></div>
        <div><strong>${fmtInt(t.filesTouched)}</strong><span>files touched</span></div>
        <div><strong>${fmtInt(stats.impact.churnFiles.length)}</strong><span>repeat-edit files</span></div>
      </div>
      <div class="grid-2 impact-grid">
        <div>
          <h3>Daily diff</h3>
          <div class="legend">
            <span class="chip"><span class="sw" style="background:var(--good)"></span>Added</span>
            <span class="chip"><span class="sw" style="background:var(--critical)"></span>Removed</span>
          </div>
          <div class="chart-wrap" id="impact-chart"></div>
        </div>
        <div>
          <h3>Directories with most edits</h3>
          <div id="directory-bars" class="mini-bars"></div>
        </div>
      </div>
      <div class="risk-head">
        <div><h3>Edit concentration map</h3><p>Score combines session count, edit count, churn, and changed lines.</p></div>
        <span class="risk-scale"><i></i> lower <i></i> middle <i></i> higher</span>
      </div>
      <div id="risk-map"></div>
    </div>
    <div class="panel feature-panel" id="scoreboard-panel">
      <h2>Agent source comparison <span class="note">· observed session metrics</span></h2>
      <div id="scoreboard"></div>
    </div>
    <div class="panel feature-panel" id="provider-panel">
      <h2>Model provider comparison <span class="note">· attributed from observed model identifiers</span></h2>
      <div id="provider-comparison"></div>
    </div>
    <div class="panel feature-panel">
      <h2>Workflow patterns <span class="note">· derived from session events</span></h2>
      <div id="workflow"></div>
    </div>
    <div class="grid-2">
      <div class="panel">
        <h2>Working rhythm <span class="note">· activity by hour × weekday</span></h2>
        <div id="punchcard"></div>
      </div>
      <div class="panel">
        <h2>Top tools</h2>
        <div class="bars" id="tool-bars"></div>
      </div>
    </div>
    <div class="panel" id="trajectory"></div>`;

  renderDailyChart();
  renderCostIntelligence();
  renderImpactChart();
  renderDirectoryBars();
  renderRiskMap();
  renderScoreboard();
  renderProviderComparison();
  renderWorkflow();
  renderPunchcard();
  renderToolBars();
  renderTrajectory();
}

function diagnosticBanner() {
  const d = state.diagnostics ?? {};
  const issues = [];
  if (d.malformedLines) issues.push(`${fmtInt(d.malformedLines)} malformed JSONL line${d.malformedLines === 1 ? '' : 's'} skipped`);
  if (d.invalidRows) issues.push(`${fmtInt(d.invalidRows)} non-object transcript record${d.invalidRows === 1 ? '' : 's'} skipped`);
  if (d.filesUnreadable) issues.push(`${fmtInt(d.filesUnreadable)} unreadable file${d.filesUnreadable === 1 ? '' : 's'}`);
  if (d.filesTooLarge) issues.push(`${fmtInt(d.filesTooLarge)} oversized file${d.filesTooLarge === 1 ? '' : 's'} skipped`);
  if (d.filesRejectedSymlink) issues.push(`${fmtInt(d.filesRejectedSymlink)} symbolic-link transcript${d.filesRejectedSymlink === 1 ? '' : 's'} rejected`);
  if (d.filesOutsideRoot) issues.push(`${fmtInt(d.filesOutsideRoot)} transcript${d.filesOutsideRoot === 1 ? '' : 's'} outside its source root rejected`);
  if (d.filesSkippedByteBudget) issues.push(`${fmtInt(d.filesSkippedByteBudget)} file${d.filesSkippedByteBudget === 1 ? '' : 's'} skipped by the total-byte limit`);
  if (d.fileBudgetReached) issues.push('transcript-file limit reached');
  if (d.sessionBudgetReached) issues.push('session limit reached');
  if (d.eventBudgetReached) issues.push(`${fmtInt(d.sessionsSkippedEventBudget ?? 0)} session${d.sessionsSkippedEventBudget === 1 ? '' : 's'} skipped by the event limit`);
  if (d.adapterErrors) issues.push(`${fmtInt(d.adapterErrors)} adapter failure${d.adapterErrors === 1 ? '' : 's'}`);
  if (d.orphanResults) issues.push(`${fmtInt(d.orphanResults)} orphan tool result${d.orphanResults === 1 ? '' : 's'}`);
  if (d.invalidSessionIds) issues.push(`${fmtInt(d.invalidSessionIds)} invalid session identifier${d.invalidSessionIds === 1 ? '' : 's'} replaced or skipped`);
  if (d.ambiguousSpawnLinks) issues.push(`${fmtInt(d.ambiguousSpawnLinks)} ambiguous spawn link${d.ambiguousSpawnLinks === 1 ? '' : 's'}`);
  if (d.cyclicSpawnLinks) issues.push(`${fmtInt(d.cyclicSpawnLinks)} cyclic spawn link${d.cyclicSpawnLinks === 1 ? '' : 's'} ignored`);
  if (d.futureSessions) issues.push(`${fmtInt(d.futureSessions)} future-dated session${d.futureSessions === 1 ? '' : 's'} excluded`);
  if (d.sessionsWithoutTimestamps) {
    const disposition = stats?.window?.days
      ? 'excluded'
      : 'included without daily attribution';
    issues.push(`${fmtInt(d.sessionsWithoutTimestamps)} session${d.sessionsWithoutTimestamps === 1 ? '' : 's'} without a valid timestamp ${disposition}`);
  }
  if (d.refreshThrottled) issues.push(`${fmtInt(d.refreshThrottled)} refresh request${d.refreshThrottled === 1 ? '' : 's'} throttled`);
  if (d.pricingError) issues.push('pricing disabled because the pricing table is invalid or unreadable');
  if (state.sessionOutput?.omitted) {
    issues.push(`${fmtInt(state.sessionOutput.omitted)} session row${state.sessionOutput.omitted === 1 ? '' : 's'} omitted from the browser view; totals still include them`);
  }
  const aggregateOmissions = Object.entries(stats?.outputLimits ?? {})
    .filter(([, value]) => value && typeof value === 'object' && value.omitted > 0)
    .reduce((total, [, value]) => total + value.omitted, 0);
  if (aggregateOmissions) {
    issues.push(`${fmtInt(aggregateOmissions)} lower-ranked aggregate row${aggregateOmissions === 1 ? '' : 's'} omitted from browser tables; totals still include them`);
  }
  const scanned = `${fmtInt(d.filesDiscovered ?? 0)} transcript file${d.filesDiscovered === 1 ? '' : 's'} scanned`;
  return `<div class="data-quality ${issues.length ? 'warn' : 'ok'}" role="${issues.length ? 'alert' : 'status'}">
    <b>Data quality</b><span>${issues.length ? issues.map(esc).join(' · ') : `${scanned} with no parser warnings`}</span>
    ${d.sessionsOutsideWindow ? `<small>${fmtInt(d.sessionsOutsideWindow)} older session${d.sessionsOutsideWindow === 1 ? '' : 's'} excluded by latest activity timestamp.</small>` : ''}
  </div>`;
}

const statTile = (k, v, d) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;

function activePlanEntries() {
  const activeSources = sourceFilter === 'all' ? Object.keys(state.counts) : [sourceFilter];
  return activeSources
    .map((source) => ({ source, ...(planConfig.plans[source] || {}) }))
    .filter((plan) => Number(plan.monthlyCost) > 0);
}

function planLabelForWindow() {
  const plans = activePlanEntries();
  if (plans.length === 1) return plans[0].name || `${sourceLabel(plans[0].source)} plan`;
  return plans.length > 1 ? 'combined plans' : 'plan';
}

function planSpendForWindow() {
  const monthly = activePlanEntries().reduce((sum, plan) => sum + Math.max(0, Number(plan.monthlyCost) || 0), 0);
  const windowMonths = Math.max(1 / 30, (stats.window.spanDays || stats.perDay.length) / 30);
  return monthly * windowMonths;
}

function renderCostIntelligence() {
  const host = $('#cost-intelligence');
  const cost = stats.cost;
  const planSpend = planSpendForWindow();
  const planLabel = planLabelForWindow();
  const roi = planSpend ? cost.total / planSpend : null;
  const coverage = fmtPct(cost.coverage, 0);
  const tokenCoverage = fmtPct(cost.tokenCoverage, 0);
  const estimateLabel = cost.isPartial ? 'API cost lower bound' : 'API-equivalent cost';
  const rows = cost.bySource.filter((r) => r.pricedSessions > 0);
  const max = Math.max(0.000001, ...rows.map((r) => r.total));
  const observedRates = stats.models.filter((m) => m.rate);
  host.innerHTML = `
    <div class="panel-title-row">
      <div><h2>API-equivalent cost and plan comparison <span class="note">· estimated at public API rates</span></h2></div>
      <button class="micro-btn" id="cost-settings">Plan setup</button>
    </div>
    <div class="roi-layout">
      <div class="roi-card">
        <div class="roi-k">API equivalent / plan spend</div>
        <div class="roi-v">${roi == null ? '—' : `${roi.toFixed(1)}×`}</div>
        <p>${cost.isPartial ? 'Priced sessions total at least' : 'Priced sessions total'} <b>${fmtMoney(cost.total)}</b> at public API rates. ${planSpend ? `Configured plan spend for this window is <b>${fmtMoney(planSpend)} (${esc(planLabel)})</b>.` : 'No plan spend is configured.'}${roi == null ? '' : ` The API-equivalent-to-plan-spend ratio is <strong>${roi.toFixed(1)}×</strong>.`}</p>
        <span>${coverage} fully priced sessions · ${fmtInt(cost.partiallyPricedSessions)} partially priced · ${tokenCoverage} of observed tokens priced · ${fmtMoney(cost.perSession)} / attributed session</span>
      </div>
      <div class="cost-breakdown">
        <div class="cost-kpis">
          <div><span>${estimateLabel}</span><b>${fmtMoney(cost.total)}</b></div>
          <div><span>API cost / parsed edit</span><b>${fmtMoney(cost.perEdit)}</b></div>
          <div><span>Plan spend</span><b>${planSpend ? fmtMoney(planSpend) : 'not set'}</b></div>
        </div>
        <div class="cost-bars">
          ${rows.length ? rows.map((r) => `
            <div class="cost-row">
              <span>${esc(sourceLabel(r.source))}</span>
              <i><i style="width:${Math.max(2, r.total / max * 100)}%"></i></i>
              <b>${fmtMoney(r.total)}</b>
              <small>${fmtMoney(r.costPerEdit)}/edit · ${fmtMoney(r.costPer100Lines)}/100 lines</small>
            </div>`).join('') : '<p class="muted-copy">No sessions match the pricing table yet.</p>'}
        </div>
      </div>
    </div>
    ${(cost.unpricedSessions || cost.partiallyPricedSessions) ? `<div class="coverage-warn">${fmtInt(cost.unpricedSessions)} wholly unpriced and ${fmtInt(cost.partiallyPricedSessions)} partially priced session${cost.unpricedSessions + cost.partiallyPricedSessions === 1 ? '' : 's'}. Usage is priced per recorded turn and model; unknown models or out-of-range dates remain unpriced. The total and ratio are lower-bound estimates.</div>` : ''}
    <details class="pricing-details">
      <summary>Observed model pricing · updated ${esc(cost.pricingUpdatedAt || 'unknown')}</summary>
      <div class="pricing-table">
        <span>Model</span><span>Input</span><span>Cache read</span><span>Write 5m</span><span>Write 1h</span><span>Output</span>
        ${observedRates.map((m) => `<b>${esc(m.name)}</b><span>${fmtMoney(m.rate.input)}</span><span>${fmtMoney(m.rate.cacheRead)}</span><span>${fmtMoney(m.rate.cacheWrite5m ?? m.rate.cacheWrite)}</span><span>${fmtMoney(m.rate.cacheWrite1h ?? m.rate.cacheWrite)}</span><span>${fmtMoney(m.rate.output)}</span>`).join('')}
      </div>
      <p class="method-note">Rates are ${esc(cost.currency)} per million tokens and are selected by each usage event's model and date. Duration-specific write rates apply where the provider reports them; otherwise the generic cache-write rate appears in both columns. Subscription usage is estimated at public API rates; this is not a vendor invoice.</p>
    </details>`;
  $('#cost-settings').addEventListener('click', openCostSettings);
}

function openCostSettings() {
  let dialog = $('#plan-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'plan-dialog';
    dialog.setAttribute('aria-labelledby', 'plan-dialog-title');
    document.body.appendChild(dialog);
  }
  const planSources = [...new Set([
    ...Object.keys(DEFAULT_PLANS),
    ...Object.keys(state.counts),
    ...(sourceFilter === 'all' ? [] : [sourceFilter]),
  ])];
  dialog.innerHTML = `
    <form method="dialog" class="plan-form">
      <div><span class="form-eyebrow">Cost intelligence</span><h2 id="plan-dialog-title">Plan setup</h2></div>
      <div class="plan-providers" role="region" aria-label="Plan providers" tabindex="0">
        ${planSources.map((source) => {
          const plan = planConfig.plans[source] || { name: `${sourceLabel(source)} plan`, monthlyCost: 0 };
          return `<section class="plan-provider">
            <div class="plan-provider-head"><strong>${esc(sourceLabel(source))}</strong><span>monthly</span></div>
            <div class="plan-fields">
              <label>Plan name<input name="name:${esc(source)}" maxlength="80" value="${esc(plan.name)}" placeholder="${esc(sourceLabel(source))} plan" /></label>
              <label>Spend (${esc(stats.cost.currency)})<input name="cost:${esc(source)}" type="number" min="0" max="${MAX_MONTHLY_PLAN_COST}" step="0.01" value="${Number(plan.monthlyCost) || 0}" /></label>
            </div>
          </section>`;
        }).join('')}
      </div>
      <p>Each plan is included only when its agent source is present in the selected view. Spend is scaled to the reporting window; set a plan to 0 to exclude it.</p>
      <div class="dialog-actions"><button value="cancel" class="micro-btn">Cancel</button><button value="save" class="micro-btn primary">Save plans</button></div>
    </form>`;
  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const data = new FormData(dialog.querySelector('form'));
    const plans = { ...planConfig.plans };
    for (const source of planSources) {
      plans[source] = {
        name: String(data.get(`name:${source}`) || `${sourceLabel(source)} plan`).slice(0, 80),
        monthlyCost: Math.min(
          MAX_MONTHLY_PLAN_COST,
          Math.max(0, Number(data.get(`cost:${source}`)) || 0),
        ),
      };
    }
    planConfig = { plans };
    storageSet('localStorage', PLAN_STORAGE_KEY, JSON.stringify(planConfig));
    renderCostIntelligence();
  }, { once: true });
  dialog.returnValue = '';
  dialog.showModal();
}

function dataTable(label, headers, rows) {
  return `<details class="chart-data">
    <summary>View ${esc(label)} data table</summary>
    <div class="table-scroll" role="region" aria-label="${esc(label)} data" tabindex="0"><table>
      <thead><tr>${headers.map((header) => `<th scope="col">${esc(header)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row) => `<tr>${row.map((cell, index) => index === 0 ? `<th scope="row">${esc(cell)}</th>` : `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </details>`;
}

function renderImpactChart() {
  const host = $('#impact-chart');
  const days = stats.perDay;
  const W = Math.max(320, host.clientWidth || 620);
  const H = 188, padL = 42, padR = 6, padT = 10, padB = 22;
  const iw = W - padL - padR, center = 83, half = 68;
  const max = Math.max(1, ...days.map((d) => Math.max(d.additions, d.deletions)));
  const step = iw / days.length;
  const barW = Math.min(Math.max(3, step * 0.62), 25);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor(iw / 58)));
  let svg = `<line x1="${padL}" x2="${W - padR}" y1="${center}" y2="${center}" stroke="var(--grid)" stroke-width="1.5"/>`;
  days.forEach((d, i) => {
    const cx = padL + step * i + step / 2, x = cx - barW / 2;
    const ah = d.additions / max * half, dh = d.deletions / max * half;
    if (ah) svg += `<rect x="${x}" y="${center - ah}" width="${barW}" height="${Math.max(1, ah)}" rx="2.5" fill="var(--good)"/>`;
    if (dh) svg += `<rect x="${x}" y="${center + 2}" width="${barW}" height="${Math.max(1, dh)}" rx="2.5" fill="var(--critical)"/>`;
    if (i % labelEvery === 0) svg += `<text x="${cx}" y="${H - 5}" font-size="10" text-anchor="middle">${fmtDay(d.date)}</text>`;
    svg += `<rect class="col-hit" data-i="${i}" x="${padL + step * i}" y="${padT}" width="${step}" height="${half * 2 + 4}"/>`;
  });
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lines added and removed per day">${svg}</svg>
    ${dataTable('daily code impact for active days', ['Date', 'Added', 'Removed', 'Edit operations'], days.filter((d) => d.additions || d.deletions || d.edits).map((d) => [d.date, `+${fmtInt(d.additions)}`, `−${fmtInt(d.deletions)}`, fmtInt(d.edits)]))}`;
  host.querySelectorAll('.col-hit').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const d = days[Number(el.dataset.i)];
      showTip(`<div class="tt-title">${fmtDay(d.date)}</div><div class="row"><span>Added</span><b>+${fmtInt(d.additions)}</b></div><div class="row"><span>Removed</span><b>−${fmtInt(d.deletions)}</b></div><div class="row"><span>Edit operations</span><b>${fmtInt(d.edits)}</b></div>`, e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', hideTip);
  });
}

const compactPath = (p, parts = 3) => {
  const segs = String(p || '.').replaceAll('\\', '/').split('/').filter(Boolean);
  return (String(p).startsWith('/') ? '…/' : '') + segs.slice(-parts).join('/');
};

function renderDirectoryBars() {
  const host = $('#directory-bars');
  const rows = stats.impact.directories.slice(0, 7);
  const max = Math.max(1, ...rows.map((r) => r.edits));
  host.innerHTML = rows.length ? rows.map((r) => `
    <div class="mini-bar" title="${esc(r.path)}">
      <div><span>${esc(compactPath(r.path, 2))}</span><b>${countLabel(r.edits, 'edit')}</b></div>
      <i><i style="width:${Math.max(2, r.edits / max * 100)}%"></i></i>
      <small>${countLabel(r.files, 'file')} · +${fmtInt(r.additions)} / −${fmtInt(r.deletions)}</small>
    </div>`).join('') : '<p class="muted-copy">No parseable code edits in this window.</p>';
}

function renderRiskMap() {
  const host = $('#risk-map');
  const rows = stats.impact.files.slice(0, 14);
  if (!rows.length) { host.innerHTML = '<p class="muted-copy">No Edit, Write, NotebookEdit, str_replace_editor, or apply_patch payloads found.</p>'; return; }
  host.innerHTML = `<div class="risk-table" role="region" aria-label="File risk map" tabindex="0">
    <div class="risk-row risk-labels"><span>File</span><span>Score</span><span>Sessions</span><span>Churn</span><span>Diff</span></div>
    ${rows.map((r) => `<div class="risk-row" title="${esc(r.path)}">
      <span class="risk-file">${esc(compactPath(r.path, 4))}</span>
      <span class="risk-cell ${r.risk}" style="--score:${r.riskScore / 100}"><b>${r.riskScore}</b></span>
      <span>${fmtInt(r.sessions)}</span>
      <span class="${r.churn ? 'churn' : ''}">${fmtInt(r.churn)}</span>
      <span><i class="add">${r.estimated ? '~' : ''}+${fmtInt(r.additions)}</i> <i class="del">−${fmtInt(r.deletions)}</i>${r.estimated ? ' <small>estimated</small>' : ''}</span>
    </div>`).join('')}
  </div>`;
}

function renderScoreboard() {
  const host = $('#scoreboard');
  const agents = stats.scoreboard;
  if (!agents.length) { host.innerHTML = '<p class="muted-copy">No agent sessions to compare.</p>'; return; }
  const minimumSessions = 5;
  const metrics = [
    { key: 'editsPerSession', label: 'Edits / session', better: 'high', sample: 'sessions', minimum: minimumSessions, fmt: (v) => v?.toFixed(2) ?? '—' },
    { key: 'outputTokensPerEdit', label: 'Output tokens / edit', better: 'low', sample: 'edits', minimum: 5, fmt: (v) => v == null ? '—' : fmtNum(v) },
    { key: 'toolErrorRate', label: 'Tool error rate', better: 'low', sample: 'toolCalls', minimum: 10, fmt: fmtPct },
    { key: 'medianToolLatencyMs', label: 'Median tool latency', better: 'low', sample: 'toolLatencies', minimum: 5, fmt: (v) => fmtDur(v) || '—' },
    { key: 'cacheEfficiency', label: 'Cache efficiency', better: 'high', sample: 'sessions', minimum: minimumSessions, fmt: fmtPct },
    { key: 'costPerEdit', label: 'API $ / edit', better: 'low', sample: 'pricedEdits', minimum: 5, fmt: fmtMoney },
    { key: 'costPer100Lines', label: 'API $ / 100 lines', better: 'low', sample: 'pricedSessions', minimum: minimumSessions, fmt: fmtMoney },
  ];
  const sampleFor = (agent, metric) => agent.samples?.[metric.sample] ?? 0;
  const bestFor = (metric) => {
    const values = agents
      .filter((agent) => agent.sessions >= minimumSessions && sampleFor(agent, metric) >= metric.minimum)
      .map((agent) => agent[metric.key])
      .filter((value) => value != null && Number.isFinite(value));
    if (values.length < 2) return null;
    return metric.better === 'high' ? Math.max(...values) : Math.min(...values);
  };
  host.innerHTML = `
    <div class="score-agents">${agents.map((a) => `<div><span>${esc(sourceLabel(a.source))}</span><b>${fmtInt(a.edits)}</b><small>edit operations · ${countLabel(a.sessions, 'session')}</small></div>`).join('')}</div>
    <div class="score-table" role="region" aria-label="Agent score comparison" tabindex="0" style="--agents:${agents.length}">
      <div class="score-row score-head"><span>Normalised metric</span>${agents.map((a) => `<b>${esc(sourceLabel(a.source))}</b>`).join('')}</div>
      ${metrics.map((m) => { const best = bestFor(m); const marker = m.better === 'high' ? 'highest' : 'lowest'; return `<div class="score-row"><span>${m.label}<small>${marker} observed value</small></span>${agents.map((a) => { const sample = sampleFor(a, m); const eligible = a.sessions >= minimumSessions && sample >= m.minimum; const highlighted = eligible && best != null && a[m.key] === best; return `<b class="${highlighted ? 'winner' : ''}">${m.fmt(a[m.key])}<small>n=${fmtInt(sample)}${eligible ? '' : ' · low sample'}</small>${highlighted ? `<i>${marker}</i>` : ''}</b>`; }).join('')}</div>`; }).join('')}
    </div>
    <p class="method-note">An edit is one confirmed file operation parsed from an edit, write, or patch payload. Each cell shows its denominator. Highlights require at least ${minimumSessions} sessions and the metric-specific minimum sample. Cost metrics include only attributed priced usage. These values do not measure task quality.</p>`;
}

function renderProviderComparison() {
  const host = $('#provider-comparison');
  const providers = stats.providers ?? [];
  if (!providers.length) {
    host.innerHTML = '<p class="muted-copy">No model usage is available for provider attribution.</p>';
    return;
  }
  const maxTokens = Math.max(1, ...providers.map((provider) => provider.totalTokens));
  const sourceList = (provider) => provider.sources.map((source) => sourceLabel(source)).join(', ');
  host.innerHTML = `
    <div class="provider-cards">
      ${providers.map((provider) => {
        const coverage = provider.pricingCoverage == null ? 'not priced' : `${fmtPct(provider.pricingCoverage, 0)} priced`;
        const cost = provider.provider === 'local'
          ? 'Local runtime'
          : provider.apiCost == null ? 'Unpriced' : fmtMoney(provider.apiCost);
        return `<article class="provider-card">
          <div class="provider-card-head">
            <div><span>Provider</span><h3>${esc(providerLabel(provider.provider))}</h3></div>
            <b>${countLabel(provider.sessions, 'session')}</b>
          </div>
          <p>${esc(sourceList(provider))}</p>
          <div class="provider-models" aria-label="Observed models">
            ${provider.models.slice(0, 2).map((model) => `<span>${esc(model)}</span>`).join('')}
            ${provider.models.length > 2 ? `<span>+${provider.models.length - 2}</span>` : ''}
          </div>
          <div class="provider-meter" aria-hidden="true"><i style="width:${Math.max(1.5, provider.totalTokens / maxTokens * 100)}%"></i></div>
          <div class="provider-metrics">
            <div><span>Tokens</span><b>${fmtNum(provider.totalTokens)}</b></div>
            <div><span>Requests</span><b>${fmtInt(provider.requests)}</b></div>
            <div><span>Cache read</span><b>${fmtPct(provider.cacheEfficiency)}</b></div>
            <div><span>API equivalent</span><b>${esc(cost)}</b><small>${esc(coverage)}</small></div>
          </div>
        </article>`;
      }).join('')}
    </div>
    ${dataTable('model provider comparison', [
      'Provider', 'Sessions', 'Agent sources', 'Models', 'Requests',
      'Input tokens', 'Output tokens', 'Cache read', 'API equivalent', 'Pricing coverage',
    ], providers.map((provider) => [
      providerLabel(provider.provider),
      fmtInt(provider.sessions),
      sourceList(provider),
      provider.models.join(', '),
      fmtInt(provider.requests),
      fmtInt(provider.inputTokens),
      fmtInt(provider.outputTokens),
      fmtInt(provider.cacheRead),
      provider.provider === 'local' ? 'Local runtime' : fmtMoney(provider.apiCost),
      fmtPct(provider.pricingCoverage, 0),
    ]))}
    <p class="method-note">Provider is a separate dimension from agent source: Cursor and Hermes can use different model providers. Model identifiers such as Nemotron, Kimi K3, GLM 5.2, Qwen 3.6, and Mistral are attributed without inventing prices. Explicit local runtimes override inference, unknown models remain visible, and local sessions are never assigned public API pricing. These values describe observed usage, not task quality.</p>`;
}

function renderWorkflow() {
  const host = $('#workflow');
  const w = stats.workflow;
  const t = stats.totals;
  const correctionRate = t.sessions ? w.sessionsCorrected / t.sessions : 0;
  const reworkRate = t.sessions ? w.sessionsWithRework / t.sessions : 0;
  const abandonedRate = t.sessions ? w.abandoned / t.sessions : 0;
  const churn = stats.impact.churnFiles[0];
  const coaching = [];
  if (churn) coaching.push(`<b>${esc(compactPath(churn.path, 3))}</b> appears in ${countLabel(churn.sessions, 'session')} with ${countLabel(churn.edits, 'edit operation')}.`);
  if (t.sessions >= 5 && correctionRate >= 0.2) coaching.push(`${fmtPct(correctionRate, 0)} of ${fmtInt(t.sessions)} sessions contain a later user message matching the correction phrase list.`);
  if (w.timeToFirstEditSamples >= 5 && w.medianTimeToFirstEditMs != null && w.medianTimeToFirstEditMs > 5 * 60_000) coaching.push(`Median time from first request to first edit is ${fmtDur(w.medianTimeToFirstEditMs)} across ${fmtInt(w.timeToFirstEditSamples)} sessions.`);
  if (!coaching.length) coaching.push('No workflow heuristic threshold was met.');
  host.innerHTML = `
    <div class="workflow-cards">
      ${workflowCard('Rework loops', fmtInt(w.reworkLoops), `${fmtPct(reworkRate, 0)} of sessions`, 'same file edited again in-session')}
      ${workflowCard('Abandoned', fmtInt(w.abandoned), `${fmtPct(abandonedRate, 0)} of sessions`, 'ended without a final assistant reply')}
      ${workflowCard('Corrections', fmtInt(w.corrections), `${fmtPct(correctionRate, 0)} of sessions`, 'negative user follow-ups after kickoff')}
      ${workflowCard('Time to first edit', fmtDur(w.medianTimeToFirstEditMs) || '—', 'median', 'first user request → first code edit')}
    </div>
    <div class="workflow-bottom">
      <div class="coach"><span>Detected patterns</span><p>${coaching.join(' ')}</p></div>
      <div class="workflow-sources" role="region" aria-label="Workflow metrics by agent" tabindex="0">
        ${stats.scoreboard.map((a) => `<div><b>${esc(sourceLabel(a.source))}</b><span>${a.reworkPerSession.toFixed(2)} rework/session</span><span>${fmtPct(a.abandonedRate)} abandoned</span><span>${fmtDur(a.medianTimeToFirstEditMs) || '—'} to edit</span></div>`).join('')}
      </div>
    </div>`;
}

const workflowCard = (label, value, detail, note) => `<div class="workflow-card"><span>${label}</span><b>${value}</b><i>${detail}</i><small>${note}</small></div>`;

// stacked columns of tokens in/out per day (single unit → one stacked axis)
function renderDailyChart() {
  const host = $('#daily-chart');
  const days = stats.perDay;
  const W = Math.max(320, host.clientWidth || 640);
  const H = 190, padL = 44, padR = 6, padT = 12, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const inOf = (d) => Math.max(0, d.tokensIn - (d.tokensCache || 0) - (d.tokensCacheWrite || 0));
  const max = Math.max(1, ...days.map((d) => inOf(d) + d.tokensOut));
  const y = (v) => padT + ih - (v / max) * ih;
  const step = iw / days.length;
  const barW = Math.min(Math.max(3, step * 0.62), 26);
  const ticks = niceTicks(max, 4);

  let g = '';
  for (const tv of ticks) {
    g += `<line x1="${padL}" x2="${W - padR}" y1="${y(tv)}" y2="${y(tv)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${padL - 7}" y="${y(tv) + 3.5}" font-size="10" text-anchor="end">${fmtNum(tv)}</text>`;
  }
  g += `<line x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}" stroke="var(--grid)" stroke-width="1.25"/>`;

  const labelEvery = Math.ceil(days.length / Math.floor(iw / 58));
  let bars = '', hits = '';
  days.forEach((d, i) => {
    const cx = padL + step * i + step / 2;
    const x0 = cx - barW / 2;
    const total = inOf(d) + d.tokensOut;
    if (i % labelEvery === 0)
      g += `<text x="${cx}" y="${H - 7}" font-size="10" text-anchor="middle">${fmtDay(d.date)}</text>`;
    if (total > 0) {
      const hIn = ((inOf(d) / max) * ih);
      const hOut = ((d.tokensOut / max) * ih);
      const yIn = padT + ih - hIn;
      // input segment sits on the baseline; output stacks above with a 2px surface gap
      if (hOut > 0.5) {
        const yOut = yIn - 2 - hOut;
        bars += roundTopRect(x0, Math.max(padT, yOut), barW, hOut, 'var(--ser-out)');
        bars += `<rect x="${x0}" y="${yIn}" width="${barW}" height="${Math.max(1, hIn)}" fill="var(--ser-in)"/>`;
      } else {
        bars += roundTopRect(x0, yIn, barW, hIn, 'var(--ser-in)');
      }
    }
    hits += `<rect class="col-hit" data-i="${i}" x="${padL + step * i}" y="${padT}" width="${step}" height="${ih}"/>`;
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Tokens per day, stacked input and output">${g}${bars}${hits}</svg>
    ${dataTable('daily token usage for active days', ['Date', 'Fresh input', 'Output', 'Cache read', 'Cache write'], days.filter((d) => d.tokensIn || d.tokensOut || d.tokensCache || d.tokensCacheWrite).map((d) => [
      d.date,
      fmtInt(inOf(d)),
      fmtInt(d.tokensOut),
      fmtInt(d.tokensCache || 0),
      fmtInt(d.tokensCacheWrite || 0),
    ]))}`;

  host.querySelectorAll('.col-hit').forEach((r) => {
    r.addEventListener('pointermove', (e) => {
      const d = days[Number(r.dataset.i)];
      showTip(
        `<div class="tt-title">${fmtDay(d.date)}</div>
         <div class="row"><span><span class="sw" style="background:var(--ser-in)"></span>Input</span><b>${fmtNum(inOf(d))}</b></div>
         <div class="row"><span><span class="sw" style="background:var(--ser-out)"></span>Output</span><b>${fmtNum(d.tokensOut)}</b></div>
         <div class="row"><span>Cache-read</span><b>${fmtNum(d.tokensCache || 0)}</b></div>
         <div class="row"><span>Cache-write</span><b>${fmtNum(d.tokensCacheWrite || 0)}</b></div>
         <div class="row"><span>Tool calls</span><b>${fmtInt(d.toolCalls)}</b></div>
         <div class="row"><span>Sessions</span><b>${fmtInt(d.sessions)}</b></div>`,
        e.clientX, e.clientY
      );
    });
    r.addEventListener('pointerleave', hideTip);
  });
}

function roundTopRect(x, y, w, h, fill) {
  if (h < 1) h = 1;
  const r = Math.min(3.5, w / 2, h);
  return `<path d="M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z" fill="${fill}"/>`;
}

function niceTicks(max, count) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const out = [];
  for (let v = step; v <= max; v += step) out.push(v);
  return out;
}

// hour × weekday heat grid (sequential single-hue ramp; near-zero recedes)
function renderPunchcard() {
  const host = $('#punchcard');
  const punch = stats.punch;
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon-first
  const values = punch.flat().filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p) => values.length ? values[Math.min(values.length - 1, Math.floor(p * values.length))] : 1;
  const th = [q(0.2), q(0.4), q(0.6), q(0.8)];
  const cls = (v) => (v <= 0 ? '' : v <= th[0] ? 'h1' : v <= th[1] ? 'h2' : v <= th[2] ? 'h3' : v <= th[3] ? 'h4' : 'h5');

  let cells = '';
  for (const w of order)
    for (let h = 0; h < 24; h++)
      cells += `<span class="cell ${cls(punch[w][h])}" data-w="${w}" data-h="${h}"></span>`;
  const hours = Array.from({ length: 24 }, (_, h) => `<span>${fmtHour(h).replace('m', '')}</span>`).join('');

  const peak = stats.records.peakHour;
  host.innerHTML = `
    <div class="punch">
      <div class="dows">${order.map((w) => `<span>${DOW[w]}</span>`).join('')}</div>
      <div class="cells">${cells}</div>
      <div></div>
      <div class="hours">${hours}</div>
    </div>
    ${peak ? `<div class="punch-note">Peak: <b>${DOW_FULL[peak.weekday]} around ${fmtHour(peak.hour)}</b> (${countLabel(peak.n, 'event')})</div>` : ''}
    ${dataTable('working rhythm', ['Weekday', 'Hour', 'Events'], order.flatMap((w) => Array.from({ length: 24 }, (_, h) => [DOW[w], fmtHour(h), fmtInt(punch[w][h])]).filter((row) => row[2] !== '0')))}`;

  host.querySelectorAll('.cell').forEach((c) => {
    c.addEventListener('pointermove', (e) => {
      const w = Number(c.dataset.w), h = Number(c.dataset.h);
      showTip(`<div class="tt-title">${DOW[w]} · ${fmtHour(h)}</div><div class="row"><span>Events</span><b>${fmtInt(punch[w][h])}</b></div>`, e.clientX, e.clientY);
    });
    c.addEventListener('pointerleave', hideTip);
  });
}

function renderToolBars() {
  const host = $('#tool-bars');
  const rows = stats.tools.slice(0, 8);
  if (!rows.length) { host.innerHTML = '<div class="node-meta">no tool calls</div>'; return; }
  const max = rows[0].count;
  host.innerHTML = rows
    .map(
      (r, i) => `
      <div class="bar-row" data-i="${i}">
        <span class="name">${esc(r.name)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(1.5, (r.count / max) * 100)}%"></span></span>
        <span class="val">${fmtInt(r.count)}</span>
      </div>`
    )
    .join('');
  host.querySelectorAll('.bar-row').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = rows[Number(el.dataset.i)];
      showTip(
        `<div class="tt-title">${esc(r.name)}</div>
         <div class="row"><span>Calls</span><b>${fmtInt(r.count)}</b></div>
         <div class="row"><span>Errors</span><b>${fmtInt(r.errors)}</b></div>`,
        e.clientX, e.clientY
      );
    });
    el.addEventListener('pointerleave', hideTip);
  });
}

// ── trajectory ───────────────────────────────────────────────────
const TRAJECTORY_PAGE_LIMIT = 100;
let trajectoryOffset = 0;
let revealSensitiveTrajectory = false;

async function selectSession(key) {
  selected = key;
  trajectoryOffset = 0;
  revealSensitiveTrajectory = false;
  renderTree();
  await renderTrajectory();
  $('#trajectory')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function renderTrajectory({
  offset = trajectoryOffset,
  revealSensitive = revealSensitiveTrajectory,
} = {}) {
  const el = $('#trajectory');
  if (!el) return;
  if (!selected) {
    el.innerHTML = '<h2>Trajectory</h2><div class="node-meta">Select a session in the strip above to view its trajectory. Sessions marked <span class="spawn-tag">↳</span> were spawned by a parent agent.</div>';
    return;
  }
  const requestedSession = selected;
  let s;
  try {
    const params = new URLSearchParams({
      key: requestedSession,
      offset: String(offset),
      limit: String(TRAJECTORY_PAGE_LIMIT),
      view: revealSensitive ? 'raw' : 'redacted',
    });
    const res = await apiFetch(`/api/session?${params}`);
    s = await res.json();
    if (!res.ok && !s.error) s.error = `session request failed (${res.status})`;
  } catch (err) {
    s = { error: err instanceof Error ? err.message : String(err) };
  }
  if (selected !== requestedSession) return;
  if (s.error) { el.innerHTML = `<h2>Trajectory</h2><div class="node-meta">${esc(s.error)}</div>`; return; }
  trajectoryOffset = s.page?.offset ?? 0;
  revealSensitiveTrajectory = Boolean(s.sensitiveContentRevealed);

  const byId = new Map(state.sessions.map((x) => [x.key, x]));
  const chain = [];
  for (let cur = s; cur; cur = cur.parent ? byId.get(cur.parent) : null) chain.unshift(cur);
  const crumbs = chain
    .map((c, i) =>
      i === chain.length - 1
        ? `<b>${esc(c.label)}</b>`
        : `<button data-key="${esc(c.key)}">${esc(c.label)}</button> <span>↳</span>`
    )
    .join(' ');

  const durMs = s.startedAt && s.endedAt ? Date.parse(s.endedAt) - Date.parse(s.startedAt) : null;
  const pageStart = s.page.total ? s.page.offset + 1 : 0;
  const pageEnd = s.page.offset + s.events.length;
  el.innerHTML = `
    <h2>Trajectory</h2>
    <div class="crumbs">${crumbs}</div>
    <div class="trajectory-privacy ${s.sensitiveContentRevealed ? 'revealed' : ''}">
      <span>${s.sensitiveContentRevealed
        ? 'Sensitive transcript content is visible on this page.'
        : 'Messages, reasoning, tool arguments, results, and local identifiers are redacted.'}</span>
      <button type="button" class="sensitive-toggle">${s.sensitiveContentRevealed ? 'Hide sensitive content' : 'Reveal sensitive content'}</button>
    </div>
    <div class="sess-meta">
      <span>source <b>${esc(s.source)}</b></span>
      <span>agent <b>${esc(s.agent)}</b></span>
      <span>provider <b>${esc(providerLabel(s.provider ?? 'unknown'))}</b></span>
      ${s.runtime ? `<span>runtime <b>${esc(s.runtime)}</b></span>` : ''}
      <span>model <b>${esc(s.model ?? '—')}</b></span>
      <span>started <b>${fmtDate(s.startedAt)}</b></span>
      <span>duration <b>${fmtDur(durMs) || '—'}</b></span>
      <span>tokens <b>${fmtNum(s.stats.tokensIn)} in / ${fmtNum(s.stats.tokensOut)} out</b></span>
      <span>API equivalent <b>${fmtMoney(s.intelligence.apiCost)}</b></span>
      ${s.intelligence.pricingPartial ? `<span>pricing <b>${fmtPct(s.intelligence.pricedTokens / Math.max(1, s.intelligence.billableTokens), 0)} token coverage · lower bound</b></span>` : ''}
      <span>impact <b>+${fmtInt(s.intelligence.additions)} / −${fmtInt(s.intelligence.deletions)}</b></span>
      ${s.intelligence.estimatedEdits ? `<span>estimated edits <b>${fmtInt(s.intelligence.estimatedEdits)}</b></span>` : ''}
      <span>first edit <b>${fmtDur(s.intelligence.timeToFirstEditMs) || '—'}</b></span>
      <span>session <b>${esc(String(s.id).slice(0, 8))}</b></span>
    </div>
    ${(s.intelligence.reworkLoops || s.intelligence.corrections || s.intelligence.abandoned) ? `<div class="session-signals">
      ${s.intelligence.reworkLoops ? `<span>${fmtInt(s.intelligence.reworkLoops)} rework loop${s.intelligence.reworkLoops === 1 ? '' : 's'}</span>` : ''}
      ${s.intelligence.corrections ? `<span>${fmtInt(s.intelligence.corrections)} correction${s.intelligence.corrections === 1 ? '' : 's'}</span>` : ''}
      ${s.intelligence.abandoned ? '<span class="bad">abandoned trajectory</span>' : ''}
    </div>` : ''}
    <div class="trajectory-controls" aria-label="Trajectory event pages">
      <button type="button" class="trajectory-page" data-offset="${s.page.previousOffset ?? ''}" ${s.page.previousOffset == null ? 'disabled' : ''}>← Previous</button>
      <span>Events ${fmtInt(pageStart)}–${fmtInt(pageEnd)} of ${fmtInt(s.page.total)}</span>
      <button type="button" class="trajectory-page" data-offset="${s.page.nextOffset ?? ''}" ${s.page.nextOffset == null ? 'disabled' : ''}>Next →</button>
    </div>
    <div class="timeline">${s.events.map(eventHtml).join('')}</div>
    <div class="trajectory-controls trajectory-controls-bottom" aria-label="Trajectory event pages">
      <button type="button" class="trajectory-page" data-offset="${s.page.previousOffset ?? ''}" ${s.page.previousOffset == null ? 'disabled' : ''}>← Previous</button>
      <span>Events ${fmtInt(pageStart)}–${fmtInt(pageEnd)} of ${fmtInt(s.page.total)}</span>
      <button type="button" class="trajectory-page" data-offset="${s.page.nextOffset ?? ''}" ${s.page.nextOffset == null ? 'disabled' : ''}>Next →</button>
    </div>`;

  for (const btn of el.querySelectorAll('.crumbs button, .spawn-open')) {
    btn.addEventListener('click', () => selectSession(btn.dataset.key));
  }
  for (const btn of el.querySelectorAll('.trajectory-page')) {
    btn.addEventListener('click', async () => {
      if (btn.disabled || btn.dataset.offset === '') return;
      await renderTrajectory({
        offset: Number(btn.dataset.offset),
        revealSensitive: revealSensitiveTrajectory,
      });
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  el.querySelector('.sensitive-toggle')?.addEventListener('click', () => renderTrajectory({
    offset: trajectoryOffset,
    revealSensitive: !revealSensitiveTrajectory,
  }));
}

function eventHtml(ev) {
  const when = `<span class="when">${fmtTime(ev.ts)}</span>`;
  if (ev.kind === 'user') return wrap('ev-user', `USER ${when}`, `<div class="body">${esc(ev.text)}</div>`);
  if (ev.kind === 'assistant') return wrap('ev-assistant', `ASSISTANT ${when}`, `<div class="body">${esc(ev.text)}</div>`);
  if (ev.kind === 'thinking')
    return wrap('ev-thinking', `THINKING ${when}`, `<details><summary>show reasoning</summary><pre>${esc(ev.text)}</pre></details>`);
  if (ev.kind === 'meta') return wrap('ev-meta', `EVENT ${when}`, `<div class="body">${esc(ev.text)}</div>`);
  if (ev.kind === 'tool') {
    const t = ev.tool;
    const spawn = Boolean(t.spawnTarget);
    const dur = t.resultTs && ev.ts ? fmtDur(Date.parse(t.resultTs) - Date.parse(ev.ts)) : '';
    const status = t.isError
      ? '<span class="badge-err">ERROR</span>'
      : (t.result != null || t.confirmed === true) ? '<span class="badge-ok">OK</span>' : '';
    const args = JSON.stringify(t.args, null, 2);
    return wrap(
      spawn ? 'ev-spawn' : 'ev-tool',
      `${spawn ? 'SPAWN' : 'TOOL'} ${when}`,
      `<div class="tool-card">
        <div class="tool-head">
          <span class="tool-name">${esc(t.name)}</span>
          ${status}
          ${dur ? `<span class="dur">${dur}</span>` : ''}
        </div>
        ${args && args !== '{}' ? `<details><summary>arguments</summary><pre>${esc(args)}</pre></details>` : ''}
        ${t.result ? `<details><summary>result: ${esc(t.result.slice(0, 120))}${t.result.length > 120 ? '…' : ''}</summary><pre>${esc(t.result)}</pre></details>` : ''}
        ${spawn ? `<button class="spawn-open" data-key="${esc(t.spawnTarget)}">Open sub-agent trajectory ↳</button>` : ''}
      </div>`
    );
  }
  return '';
}

const wrap = (cls, who, body) => `<div class="ev ${cls}"><span class="who">${who}</span>${body}</div>`;

// ── Wrapped: your usage as a story ───────────────────────────────
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

function wrappedSlides() {
  const t = stats.totals;
  const r = stats.records;
  const tokens = t.tokensIn - t.cacheRead - (t.cacheWrite || 0) + t.tokensOut;
  const words = tokens * 0.75;
  const rangeLabel = `${fmtDay(stats.window.from)}–${fmtDay(stats.window.to)}`;
  const [t1, t2, t3] = stats.tools;
  const slides = [];

  slides.push({
    kicker: 'RunLume presents', dur: 4200,
    html: `<div class="w-title">Your <em>${esc(sourceLabel(sourceFilter))}</em><br/>Wrapped</div>
           <div class="w-line">${rangeLabel} · <b>${countLabel(t.sessions, 'session')}</b> on the record.<br/>Let's roll the tape.</div>`,
  });

  slides.push({
    kicker: 'the volume', dur: 5200,
    html: `<div class="w-num"><span class="cnt" data-v="${tokens}" data-f="num">0</span><span class="unit">tokens exchanged</span></div>
           <div class="w-line">Estimated at <b>${fmtNum(words)}</b> words using 0.75 words per token.
           ${t.cacheRead > 0 ? `<br/><b>${fmtNum(t.cacheRead)}</b> cache-read tokens were reused as context.` : ''}</div>`,
  });

  if (t1) slides.push({
    kicker: 'the workhorse', dur: 5200,
    html: `<div class="w-num" style="font-size:clamp(54px,10vw,120px)">${esc(t1.name)}<span class="unit"><span class="cnt" data-v="${t1.count}" data-f="int">0</span> ${t1.count === 1 ? 'call' : 'calls'}</span></div>
           <div class="w-line">${t2 ? `Then <b>${esc(t2.name)}</b> (${fmtInt(t2.count)})` : ''}${t3 ? ` and <b>${esc(t3.name)}</b> (${fmtInt(t3.count)})` : ''}${t2 ? '. You have a type.' : 'Your one true tool.'}</div>`,
  });

  slides.push({
    kicker: 'the output', dur: 5200,
    html: `<div class="w-num">+<span class="cnt" data-v="${t.additions}" data-f="int">0</span><span class="unit">lines added · −${fmtInt(t.deletions)} removed</span></div>
           <div class="w-line">across <b>${countLabel(t.filesTouched, 'distinct file')}</b> and <b>${countLabel(t.edits, 'parsed edit operation')}</b>.</div>`,
  });

  const wrappedPlanSpend = planSpendForWindow();
  const wrappedPlanLabel = planLabelForWindow();
  const wrappedRoi = wrappedPlanSpend ? stats.cost.total / wrappedPlanSpend : null;
  slides.push({
    kicker: 'the comparison', dur: 5600,
    html: `<div class="w-num">${wrappedRoi == null ? fmtMoney(stats.cost.total) : `${wrappedRoi.toFixed(1)}×`}<span class="unit">${wrappedRoi == null ? 'API-equivalent cost' : 'API equivalent / plan spend'}</span></div>
           <div class="w-line">${stats.cost.isPartial ? 'Priced sessions total at least' : 'Priced sessions total'} <b>${fmtMoney(stats.cost.total)}</b> at public API rates${wrappedPlanSpend ? `. Configured plan spend is <b>${fmtMoney(wrappedPlanSpend)} (${esc(wrappedPlanLabel)})</b>` : ''}. <span class="hl">${fmtPct(stats.cost.tokenCoverage, 0)} token pricing coverage${stats.cost.isPartial ? ' · lower-bound estimate' : ''}.</span></div>`,
  });

  if (r.peakHour) {
    const h = r.peakHour.hour;
    const vibe = h >= 22 || h <= 4 ? 'Certified night shipper.' : h < 9 ? 'Dawn patrol.' : h >= 18 ? 'Evening flow state.' : 'Daylight operator.';
    const hourTotals = Array.from({ length: 24 }, (_, i) => stats.punch.reduce((a, row) => a + row[i], 0));
    const hmax = Math.max(...hourTotals, 1);
    const mini = hourTotals.map((v, i) =>
      `<i style="height:${8 + (v / hmax) * 46}px;${i === h ? 'background:#2997ff' : ''}"></i>`).join('');
    slides.push({
      kicker: 'the rhythm', dur: 5600,
      html: `<div class="w-title">Peak hour:<br/><em>${fmtHour(h)}</em></div>
             <div class="w-minipunch" style="align-items:flex-end">${mini}</div>
             <div class="w-line">Busiest on <b>${DOW_FULL[r.peakHour.weekday]}</b>. <span class="hl">${vibe}</span></div>`,
    });
  }

  slides.push(t.spawns > 0 ? {
    kicker: 'the fleet', dur: 5200,
    html: `<div class="w-num"><span class="cnt" data-v="${t.spawns}" data-f="int">0</span><span class="unit">sub-agents dispatched</span></div>
           <div class="w-line">${r.longestSession ? `Longest run: <b>${esc(r.longestSession.label)}</b> (<span class="hl">${fmtDur(r.longestSession.ms)}</span>).` : 'Session duration is unavailable.'}</div>`,
  } : {
    kicker: 'the session shape', dur: 5200,
    html: `<div class="w-title">No<br/><em>sub-agents</em></div>
           <div class="w-line">Zero sub-agents were recorded.${r.longestSession ? ` Longest session: <b>${fmtDur(r.longestSession.ms)}</b>.` : ''}</div>`,
  });

  slides.push({
    kicker: 'tool errors', dur: 5200,
    html: `<div class="w-num"><span class="cnt" data-v="${t.errors}" data-f="int">0</span><span class="unit">tool errors recorded</span></div>
           <div class="w-line">${t.errors === 0 ? 'No tool errors were recorded in this window.' : `The observed tool error rate is ${((t.errors / Math.max(1, t.toolCalls)) * 100).toFixed(1)}%. Affected trajectories remain available for inspection.`}</div>`,
  });

  slides.push({
    kicker: '', dur: 12_000, hint: 'screenshot this one',
    html: `<div class="w-card">
      <div class="head"><span class="t">${esc(sourceLabel(sourceFilter))} <em>Wrapped</em></span><span class="range">${rangeLabel}</span></div>
      <div class="grid">
        ${cardCell(fmtNum(tokens), 'tokens')}
        ${cardCell(fmtInt(t.sessions), 'sessions')}
        ${cardCell(fmtInt(t.toolCalls), 'tool calls')}
        ${cardCell(`+${fmtNum(t.additions)}`, 'lines added')}
        ${cardCell(fmtInt(t.spawns), 'sub-agents')}
        ${cardCell(wrappedRoi == null ? fmtMoney(stats.cost.total) : `${wrappedRoi.toFixed(1)}×`, wrappedRoi == null ? 'API equivalent' : 'plan ratio')}
      </div>
      <div class="foot"><span>Run<span class="dot">·</span>Lume</span><span>${t1 ? `favorite tool: ${esc(t1.name)}` : ''}</span></div>
    </div>`,
  });

  return slides;
}
const cardCell = (n, l) => `<div class="cell"><div class="n">${n}</div><div class="l">${l}</div></div>`;

let wrappedTimer = null;
let wrappedReturnFocus = null;
function openWrapped() {
  if (!stats || !stats.totals.sessions) return;
  closeWrapped();
  const slides = wrappedSlides();
  let idx = 0;

  const root = document.createElement('div');
  root.id = 'wrapped';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', `${sourceLabel(sourceFilter)} Wrapped`);
  root.innerHTML = `
    <div class="w-progress">${slides.map(() => '<span><i></i></span>').join('')}</div>
    <div class="w-top">
      <span>${esc(sourceLabel(sourceFilter))} · Wrapped</span>
      <button class="w-close" aria-label="Close"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="w-stage"></div>
    <div class="w-hint"></div>`;
  wrappedReturnFocus = document.activeElement === document.body
    ? $('#wrapped-btn')
    : document.activeElement;
  for (const background of document.querySelectorAll('header, .layout')) {
    background.inert = true;
    background.setAttribute('aria-hidden', 'true');
  }
  document.body.appendChild(root);

  const stage = root.querySelector('.w-stage');
  const bars = [...root.querySelectorAll('.w-progress span')];
  const hint = root.querySelector('.w-hint');

  function show(i) {
    idx = Math.max(0, Math.min(slides.length - 1, i));
    const s = slides[idx];
    bars.forEach((b, j) => {
      b.classList.toggle('done', j < idx);
      b.classList.toggle('now', j === idx);
      if (j === idx) { b.style.setProperty('--w-dur', `${s.dur}ms`); b.querySelector('i').style.animation = 'none'; void b.offsetWidth; b.querySelector('i').style.animation = ''; }
    });
    stage.innerHTML = `<div class="w-slide">${s.kicker ? `<div class="w-kicker">${s.kicker}</div>` : ''}${s.html}</div>`;
    hint.textContent = s.hint || 'tap → · esc to exit';
    animateCounts(stage);
    clearTimeout(wrappedTimer);
    if (idx < slides.length - 1) wrappedTimer = setTimeout(() => show(idx + 1), s.dur);
  }

  function onKey(e) {
    if (e.key === 'Escape') closeWrapped();
    else if (e.target.closest('.w-close')) return;
    else if (e.key === 'ArrowRight' || e.key === ' ') show(idx + 1);
    else if (e.key === 'ArrowLeft') show(idx - 1);
    else if (e.key === 'Tab') {
      e.preventDefault();
      root.querySelector('.w-close').focus();
    }
  }
  root.addEventListener('click', (e) => {
    if (e.target.closest('.w-close')) return closeWrapped();
    show(e.clientX < innerWidth / 3 ? idx - 1 : idx + 1);
  });
  document.addEventListener('keydown', onKey);
  root._cleanup = () => document.removeEventListener('keydown', onKey);
  show(0);
  root.querySelector('.w-close').focus();
}

function closeWrapped() {
  clearTimeout(wrappedTimer);
  const el = $('#wrapped');
  if (el) {
    const returnFocus = wrappedReturnFocus;
    el._cleanup?.();
    el.remove();
    for (const background of document.querySelectorAll('header, .layout')) {
      background.inert = false;
      background.removeAttribute('inert');
      background.removeAttribute('aria-hidden');
    }
    wrappedReturnFocus = null;
    if (returnFocus?.isConnected) {
      returnFocus.focus();
      if (document.activeElement !== returnFocus) {
        setTimeout(() => returnFocus.isConnected && returnFocus.focus(), 0);
      }
    }
  }
}

function animateCounts(scope) {
  for (const el of scope.querySelectorAll('.cnt')) {
    const target = Number(el.dataset.v);
    const fmt = el.dataset.f === 'int' ? fmtInt : fmtNum;
    if (REDUCED || target === 0) { el.textContent = fmt(target); continue; }
    const t0 = performance.now(), dur = 1400;
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(2, -10 * p); // easeOutExpo
      el.textContent = fmt(target * eased);
      if (p < 1 && el.isConnected) requestAnimationFrame(tick);
      else el.textContent = fmt(target);
    };
    requestAnimationFrame(tick);
  }
}

// ── boot ─────────────────────────────────────────────────────────
let lastManualRefreshAt = -Infinity;
$('#refresh').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastManualRefreshAt < 2_000) return;
  lastManualRefreshAt = now;
  loadState(true);
});
$('#wrapped-btn').addEventListener('click', openWrapped);

let resizeT = null;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => {
    if (state.sessions.length && $('#daily-chart')) renderDailyChart();
    if (state.sessions.length && $('#impact-chart')) renderImpactChart();
  }, 160);
});

setInterval(() => {
  if (!document.hidden) loadState();
}, 10_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadState();
});
loadState();
