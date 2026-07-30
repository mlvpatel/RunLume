#!/usr/bin/env node
/**
 * RunLume: read-only analysis of local agent transcripts.
 *
 * Usage:
 *   node server.mjs
 *   node server.mjs --sources claude-code,codex
 *   node server.mjs --days 90 | --all
 *   node server.mjs --pricing ./rates.json
 *   node server.mjs --port 5000
 */
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAdapters } from './adapters.mjs';
import {
  buildStats,
  calendarWindowStart,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  inferProvider,
  sessionIntelligence,
  sessionSummary,
  validatePricing,
} from './analytics.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const SOURCE_NAMES = new Set(['claude-code', 'cursor', 'codex', 'gemini', 'api-log', 'hermes']);
const SNAPSHOT_TTL_MS = 1_000;
const API_STRING_LIMIT = 100_000;
const API_COLLECTION_LIMIT = 250;
const API_SESSION_LIMIT = 10_000;
const ACCESS_COOKIE_PREFIX = 'runlume_access_';
const DEFAULT_EVENT_PAGE_LIMIT = 100;
const MAX_EVENT_PAGE_LIMIT = 250;
const MAX_WINDOW_DAYS = 3_650;
const MAX_PRICING_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 10_000,
  maxTotalBytes: 640 * 1024 * 1024,
  maxEvents: 1_000_000,
  maxSessions: 10_000,
  minRefreshMs: 2_000,
});
export const MAX_RESOURCE_LIMITS = Object.freeze({
  maxFileBytes: 512 * 1024 * 1024,
  maxFiles: 100_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxEvents: 2_000_000,
  maxSessions: 50_000,
  minRefreshMs: 60 * 60 * 1000,
});
const STATIC_ROOT = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

export const HELP = `RunLume ${PACKAGE.version}

Usage: node server.mjs [options]

  --days <n>                activity window in days (1-3650); default: 30
  --all                     include all discovered sessions
  --sources <list>          claude-code,cursor,codex,gemini,api-log,hermes
  --import-dir <path>       opt-in provider or local-model JSONL captures
  --pricing <path>          custom per-model pricing JSON
  --port <number>           localhost port; default: 4477
  --help                    show this help
  --version                 show the installed version

Environment:
  PORT, RUNLUME_IMPORT_DIR, RUNLUME_PRICING,
  CLAUDE_CONFIG_DIR, CURSOR_STATE_DIR, CODEX_HOME,
  GEMINI_STATE_DIR, GEMINI_CLI_HOME, HERMES_STATE_DIR,
  RUNLUME_MAX_FILE_BYTES, RUNLUME_MAX_FILES, RUNLUME_MAX_TOTAL_BYTES,
  RUNLUME_MAX_EVENTS, RUNLUME_MAX_SESSIONS, RUNLUME_MIN_REFRESH_MS
`;

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function nonEmptyEnvironmentValue(value) {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

function positiveIntegerEnv(env, name, fallback, { allowZero = false, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (env[name] == null || env[name] === '') return fallback;
  const value = Number(env[name]);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer of at least ${minimum} and at most ${maximum}`);
  }
  return value;
}

export function parseConfig(args = process.argv.slice(2), env = process.env) {
  const valueFlags = new Set(['--days', '--sources', '--import-dir', '--pricing', '--port']);
  const booleanFlags = new Set(['--all', '--help', '--version']);
  const seenFlags = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!valueFlags.has(arg) && !booleanFlags.has(arg)) throw new Error(`unknown option: ${arg}`);
    if (seenFlags.has(arg)) throw new Error(`${arg} may only be provided once`);
    seenFlags.add(arg);
    if (booleanFlags.has(arg)) continue;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${arg} requires a value`);
    index++;
  }
  if (args.includes('--all') && args.includes('--days')) throw new Error('--all and --days cannot be used together');

  const rawPort = valueAfter(args, '--port') ?? nonEmptyEnvironmentValue(env.PORT) ?? '4477';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`invalid port: ${rawPort}`);

  const rawDays = valueAfter(args, '--days') ?? '30';
  const days = args.includes('--all') ? Infinity : Number(rawDays);
  if (
    !args.includes('--all')
    && (!Number.isSafeInteger(days) || days < 1 || days > MAX_WINDOW_DAYS)
  ) {
    throw new Error(`invalid day window: ${rawDays}; expected 1-${MAX_WINDOW_DAYS}`);
  }

  const rawImportDir = valueAfter(args, '--import-dir')
    ?? nonEmptyEnvironmentValue(env.RUNLUME_IMPORT_DIR)
    ?? null;
  const importDir = rawImportDir ? path.resolve(rawImportDir) : null;
  const rawSources = valueAfter(args, '--sources');
  const sources = rawSources ? [...new Set(rawSources.split(',').map((source) => source.trim()).filter(Boolean))] : null;
  if (rawSources != null && sources.length === 0) {
    throw new Error('--sources requires at least one source');
  }
  const unknownSources = sources?.filter((source) => !SOURCE_NAMES.has(source)) ?? [];
  if (unknownSources.length) throw new Error(`unknown source${unknownSources.length === 1 ? '' : 's'}: ${unknownSources.join(', ')}`);
  if (sources?.includes('api-log') && !importDir) {
    throw new Error('--sources api-log requires --import-dir or RUNLUME_IMPORT_DIR');
  }

  return {
    port,
    days,
    importDir,
    sources,
    limits: {
      maxFileBytes: positiveIntegerEnv(env, 'RUNLUME_MAX_FILE_BYTES', DEFAULT_RESOURCE_LIMITS.maxFileBytes, { maximum: MAX_RESOURCE_LIMITS.maxFileBytes }),
      maxFiles: positiveIntegerEnv(env, 'RUNLUME_MAX_FILES', DEFAULT_RESOURCE_LIMITS.maxFiles, { maximum: MAX_RESOURCE_LIMITS.maxFiles }),
      maxTotalBytes: positiveIntegerEnv(env, 'RUNLUME_MAX_TOTAL_BYTES', DEFAULT_RESOURCE_LIMITS.maxTotalBytes, { maximum: MAX_RESOURCE_LIMITS.maxTotalBytes }),
      maxEvents: positiveIntegerEnv(env, 'RUNLUME_MAX_EVENTS', DEFAULT_RESOURCE_LIMITS.maxEvents, { maximum: MAX_RESOURCE_LIMITS.maxEvents }),
      maxSessions: positiveIntegerEnv(env, 'RUNLUME_MAX_SESSIONS', DEFAULT_RESOURCE_LIMITS.maxSessions, { maximum: MAX_RESOURCE_LIMITS.maxSessions }),
      minRefreshMs: positiveIntegerEnv(env, 'RUNLUME_MIN_REFRESH_MS', DEFAULT_RESOURCE_LIMITS.minRefreshMs, { allowZero: true, maximum: MAX_RESOURCE_LIMITS.minRefreshMs }),
    },
    pricingFile: path.resolve(
      valueAfter(args, '--pricing')
      ?? nonEmptyEnvironmentValue(env.RUNLUME_PRICING)
      ?? path.join(__dirname, 'pricing.json'),
    ),
  };
}

export function isAllowedHost(hostHeader, port) {
  if (
    typeof hostHeader !== 'string'
    || !hostHeader
    || /[\s\/@?#\\,]/.test(hostHeader)
  ) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
    const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
    const requestPort = parsed.port ? Number(parsed.port) : 80;
    return local && (port === 0 || requestPort === port);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin, port) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:'
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && isAllowedHost(parsed.host, port);
  } catch {
    return false;
  }
}

function securityHeaders(contentType, cacheControl = 'no-store') {
  return {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'none'; object-src 'none'; media-src 'none'; worker-src 'none'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
}

function json(res, obj, status = 200, headOnly = false) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(headOnly ? undefined : body);
}

function shortPath(value) {
  const home = process.env.HOME;
  return home && (value === home || value.startsWith(`${home}${path.sep}`))
    ? `~${value.slice(home.length)}`
    : value;
}

export function isRealPathWithin(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    return realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
  } catch {
    return false;
  }
}

function* sessionTimestampValues(session) {
  yield session.startedAt;
  yield session.endedAt;
  for (const event of session.events) {
    yield event.ts;
    if (event.kind === 'tool') yield event.tool?.resultTs;
  }
  for (const usage of Array.isArray(session.usage) ? session.usage : []) yield usage?.ts;
}

function parsedTimestamp(value) {
  if (typeof value !== 'string' || !value || value.length > 128) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function latestSessionMs(session, maximum = Infinity) {
  let latest = null;
  for (const value of sessionTimestampValues(session)) {
    const parsed = parsedTimestamp(value);
    if (parsed != null && parsed <= maximum && (latest == null || parsed > latest)) latest = parsed;
  }
  return latest;
}

function hasSessionActivityAfter(session, maximum) {
  for (const value of sessionTimestampValues(session)) {
    const parsed = parsedTimestamp(value);
    if (parsed != null && parsed > maximum) return true;
  }
  return false;
}

function readPricingDocument(file) {
  let descriptor = null;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    const named = fs.lstatSync(file);
    if (!opened.isFile()) throw new Error('pricing path must be a regular file');
    if (named.isSymbolicLink()) throw new Error('pricing file must not be a symbolic link');
    if (
      (named.dev !== 0 || opened.dev !== 0 || named.ino !== 0 || opened.ino !== 0)
      && (named.dev !== opened.dev || named.ino !== opened.ino)
    ) {
      throw new Error('pricing file changed while it was being opened');
    }
    if (opened.size > MAX_PRICING_FILE_BYTES) {
      throw new Error(`pricing file exceeds ${MAX_PRICING_FILE_BYTES} bytes`);
    }
    const text = fs.readFileSync(descriptor, 'utf8');
    const completed = fs.fstatSync(descriptor);
    if (
      completed.size !== opened.size
      || completed.mtimeMs !== opened.mtimeMs
      || completed.ctimeMs !== opened.ctimeMs
      || completed.ino !== opened.ino
    ) {
      throw new Error('pricing file changed while it was being read');
    }
    return { stat: completed, text };
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function publicKey(session) {
  const digest = crypto.createHash('sha256')
    .update(String(session.source))
    .update('\0')
    .update(String(session.file))
    .update('\0')
    .update(String(session.id))
    .digest('hex')
    .slice(0, 24);
  return `${session.source}:${digest}`;
}

function cloneForApi(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > API_STRING_LIMIT
      ? `${value.slice(0, API_STRING_LIMIT)}\n… [truncated ${value.length - API_STRING_LIMIT} characters]`
      : value;
  }
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 8) return '[maximum depth reached]';
  if (Array.isArray(value)) {
    const kept = value.slice(0, API_COLLECTION_LIMIT).map((item) => cloneForApi(item, depth + 1));
    if (value.length > kept.length) kept.push(`… [truncated ${value.length - kept.length} items]`);
    return kept;
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, API_COLLECTION_LIMIT).map(([key, item]) => [key, cloneForApi(item, depth + 1)]),
  );
}

function redactedSessionId(session) {
  return String(session.key ?? publicKey(session)).split(':').at(-1);
}

function redactedEvent(event) {
  if (event.kind === 'tool') {
    return {
      kind: 'tool',
      ts: event.ts,
      tool: {
        id: null,
        name: event.tool.name,
        args: { redacted: true },
        result: event.tool.result == null ? null : '[redacted tool result]',
        isError: Boolean(event.tool.isError),
        resultTs: event.tool.resultTs,
        ...(event.tool.confirmed === true ? { confirmed: true } : {}),
        ...(event.tool.spawnTarget ? { spawnTarget: event.tool.spawnTarget } : {}),
      },
    };
  }
  const labels = {
    user: '[redacted user message]',
    assistant: '[redacted assistant message]',
    thinking: '[redacted reasoning]',
    meta: '[redacted event metadata]',
  };
  return { kind: event.kind, ts: event.ts, text: labels[event.kind] ?? '[redacted event]' };
}

function safeSessionSummary(session, pricing, revealSensitive = false, analysis = null) {
  const summary = sessionSummary(session, pricing, false, analysis);
  const toolCounts = Object.entries(summary.stats.toolCounts ?? {});
  summary.stats = {
    ...summary.stats,
    toolCounts: Object.fromEntries(toolCounts.slice(0, API_COLLECTION_LIMIT)),
    toolNamesOmitted: Math.max(0, toolCounts.length - API_COLLECTION_LIMIT),
    toolCallsTotal: toolCounts.reduce((total, [, count]) => total + Number(count || 0), 0),
  };
  if (revealSensitive) return summary;
  const id = redactedSessionId(session);
  return {
    ...summary,
    id,
    agent: 'local agent',
    label: `Session ${id.slice(0, 8)}`,
    intelligence: {
      ...summary.intelligence,
      files: summary.intelligence.files.map((file, index) => ({
        ...file,
        path: `File ${index + 1}`,
      })),
    },
  };
}

export function sessionPageForApi(session, pricing, {
  offset = 0,
  limit = DEFAULT_EVENT_PAGE_LIMIT,
  revealSensitive = false,
  analysis = null,
} = {}) {
  const intel = analysis ?? sessionIntelligence(session, pricing);
  const total = intel.events.length;
  const events = intel.events
    .slice(offset, offset + limit)
    .map((event) => (revealSensitive ? event : redactedEvent(event)));
  return cloneForApi({
    ...safeSessionSummary(session, pricing, revealSensitive, intel),
    sensitiveContentRevealed: revealSensitive,
    events,
    page: {
      offset,
      limit,
      total,
      hasMore: offset + events.length < total,
      nextOffset: offset + events.length < total ? offset + events.length : null,
      previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
    },
  });
}

function outputLimit(total, shown) {
  return { total, shown, omitted: Math.max(0, total - shown) };
}

export function redactedStats(stats) {
  const tools = stats.tools.slice(0, API_COLLECTION_LIMIT);
  const modelRateTotal = stats.models.reduce(
    (total, model) => total + (Array.isArray(model.rates) ? model.rates.length : 0),
    0,
  );
  const models = stats.models.slice(0, API_COLLECTION_LIMIT).map((model) => ({
    ...model,
    rates: Array.isArray(model.rates)
      ? model.rates.slice(0, API_COLLECTION_LIMIT)
      : [],
  }));
  const modelRateShown = models.reduce((total, model) => total + model.rates.length, 0);
  const files = stats.impact.files.slice(0, API_COLLECTION_LIMIT);
  const directories = stats.impact.directories.slice(0, API_COLLECTION_LIMIT);
  const churnFiles = stats.impact.churnFiles.slice(0, API_COLLECTION_LIMIT);
  const costSessions = stats.cost.sessions.slice(0, API_COLLECTION_LIMIT);
  const providers = stats.providers.map((provider) => ({
    ...provider,
    models: provider.models.slice(0, API_COLLECTION_LIMIT),
  }));
  const providerModelTotal = stats.providers.reduce(
    (total, provider) => total + provider.models.length,
    0,
  );
  const providerModelShown = providers.reduce(
    (total, provider) => total + provider.models.length,
    0,
  );
  const safe = structuredClone({
    ...stats,
    tools,
    models,
    impact: { ...stats.impact, files, directories, churnFiles },
    providers,
    cost: { ...stats.cost, sessions: costSessions },
    outputLimits: {
      maxRowsPerCollection: API_COLLECTION_LIMIT,
      tools: outputLimit(stats.tools.length, tools.length),
      models: outputLimit(stats.models.length, models.length),
      modelRates: outputLimit(modelRateTotal, modelRateShown),
      files: outputLimit(stats.impact.files.length, files.length),
      directories: outputLimit(stats.impact.directories.length, directories.length),
      churnFiles: outputLimit(stats.impact.churnFiles.length, churnFiles.length),
      costSessions: outputLimit(stats.cost.sessions.length, costSessions.length),
      providerModels: outputLimit(providerModelTotal, providerModelShown),
    },
  });
  const directoryLabels = new Map();
  const fileLabels = new Map();
  const seenFiles = new WeakSet();
  const directoryLabel = (project, directory) => {
    const directoryKey = `${project ?? ''}\0${directory ?? ''}`;
    if (!directoryLabels.has(directoryKey)) {
      directoryLabels.set(directoryKey, `Directory ${directoryLabels.size + 1}`);
    }
    return directoryLabels.get(directoryKey);
  };
  const redactFile = (file) => {
    if (seenFiles.has(file)) return;
    seenFiles.add(file);
    const fileKey = `${file.project ?? ''}\0${file.path}`;
    if (!fileLabels.has(fileKey)) fileLabels.set(fileKey, `File ${fileLabels.size + 1}`);
    file.path = fileLabels.get(fileKey);
    file.directory = directoryLabel(file.project, file.directory);
    delete file.project;
  };
  safe.impact.files.forEach(redactFile);
  safe.impact.churnFiles.forEach(redactFile);
  safe.impact.directories.forEach((directory) => {
    directory.path = directoryLabel(directory.project, directory.path);
    delete directory.project;
  });
  safe.cost.sessions.forEach((session, index) => {
    session.id = `session-${index + 1}`;
    session.label = `Session ${index + 1}`;
  });
  if (safe.records.longestSession) {
    safe.records.longestSession.id = 'redacted';
    safe.records.longestSession.label = 'Redacted session';
  }
  return safe;
}

function apiSessionSummary(session, analysis = null) {
  const summary = sessionSummary(session, null, false, analysis);
  const id = redactedSessionId(session);
  const toolCounts = Object.entries(summary.stats.toolCounts ?? {});
  return cloneForApi({
    key: session.key,
    id,
    source: session.source,
    agent: 'local agent',
    label: `Session ${id.slice(0, 8)}`,
    model: summary.model,
    provider: summary.provider,
    runtime: summary.runtime,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    parent: session.parent,
    children: session.children,
    stats: {
      ...summary.stats,
      toolCounts: Object.fromEntries(toolCounts.slice(0, API_COLLECTION_LIMIT)),
      toolNamesOmitted: Math.max(0, toolCounts.length - API_COLLECTION_LIMIT),
      toolCallsTotal: toolCounts.reduce((total, [, count]) => total + Number(count || 0), 0),
    },
    eventCount: summary.eventCount,
  });
}

function sessionsForApi(sessions, analysisByKey = null) {
  const shown = sessions.slice(0, API_SESSION_LIMIT);
  return {
    sessions: shown.map((session) => apiSessionSummary(session, analysisByKey?.get(session.key))),
    sessionOutput: outputLimit(sessions.length, shown.length),
  };
}

function redactedDiagnostics(diagnostics) {
  return {
    ...diagnostics,
    pricingError: diagnostics.pricingError
      ? 'pricing table unavailable or invalid'
      : null,
  };
}

function redactedRoots(roots) {
  return [...new Set(roots.map((root) => `${root.split(':', 1)[0]}: local transcript root`))];
}

export function isAuthorized(authorization, token) {
  if (typeof authorization !== 'string' || typeof token !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) return false;
  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function cookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== 'string') return null;
  let found = null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    if (found != null) return null;
    const value = part.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
    found = value;
  }
  return found;
}

function browserCookieToken(token) {
  return crypto.createHmac('sha256', token)
    .update('runlume-browser-session-v1')
    .digest('base64url');
}

function browserCookieName(port) {
  return `${ACCESS_COOKIE_PREFIX}${port}`;
}

export function isRequestAuthorized(headers, token, port = 4_477) {
  if (isAuthorized(headers?.authorization, token)) return true;
  if (typeof token !== 'string') return false;
  const cookieToken = cookieValue(headers?.cookie, browserCookieName(port));
  return cookieToken
    ? isAuthorized(`Bearer ${cookieToken}`, browserCookieToken(token))
    : false;
}

export function isDocumentNavigation(req) {
  const mode = req.headers['sec-fetch-mode'];
  const destination = req.headers['sec-fetch-dest'];
  const site = req.headers['sec-fetch-site'];
  return req.method === 'GET'
    && !req.headers.origin
    && (site == null || site === 'none' || site === 'same-origin')
    && (destination == null || destination === 'document')
    && (mode == null || mode === 'navigate' || destination == null);
}

function paginationFrom(url) {
  const parse = (name, fallback, { min, max }) => {
    const value = url.searchParams.get(name);
    if (value == null) return fallback;
    if (!/^\d+$/.test(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  };
  const offset = parse('offset', 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
  const limit = parse('limit', DEFAULT_EVENT_PAGE_LIMIT, { min: 1, max: MAX_EVENT_PAGE_LIMIT });
  return offset == null || limit == null ? null : { offset, limit };
}

export function createDashboard({
  config,
  logger = console,
  apiToken = crypto.randomBytes(32).toString('base64url'),
} = {}) {
  if (!config) throw new Error('createDashboard requires a validated config');
  if (
    config.days !== Infinity
    && (!Number.isSafeInteger(config.days) || config.days < 1 || config.days > MAX_WINDOW_DAYS)
  ) {
    throw new Error(`createDashboard requires days to be 1-${MAX_WINDOW_DAYS} or Infinity`);
  }
  if (typeof apiToken !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(apiToken)) {
    throw new Error('createDashboard requires a high-entropy API token');
  }
  const limits = { ...DEFAULT_RESOURCE_LIMITS, ...(config.limits ?? {}) };
  for (const name of ['maxFileBytes', 'maxFiles', 'maxTotalBytes', 'maxEvents', 'maxSessions']) {
    if (
      !Number.isSafeInteger(limits[name])
      || limits[name] < 1
      || limits[name] > MAX_RESOURCE_LIMITS[name]
    ) {
      throw new Error(`createDashboard requires ${name} to be a positive integer no greater than ${MAX_RESOURCE_LIMITS[name]}`);
    }
  }
  if (
    !Number.isSafeInteger(limits.minRefreshMs)
    || limits.minRefreshMs < 0
    || limits.minRefreshMs > MAX_RESOURCE_LIMITS.minRefreshMs
  ) {
    throw new Error(`createDashboard requires minRefreshMs to be from 0 to ${MAX_RESOURCE_LIMITS.minRefreshMs}`);
  }
  const adapters = makeAdapters({
    hermesDir: config.hermesDir,
    importDir: config.importDir,
    sources: config.sources,
    maxFileBytes: limits.maxFileBytes,
  });
  const fileCache = new Map();
  let snapshot = null;
  let pricingEntry = null;

  function loadPricing() {
    let stat;
    try {
      const opened = readPricingDocument(config.pricingFile);
      stat = opened.stat;
      if (
        pricingEntry?.mtimeMs === stat.mtimeMs
        && pricingEntry?.ctimeMs === stat.ctimeMs
        && pricingEntry?.size === stat.size
        && pricingEntry?.ino === stat.ino
      ) return pricingEntry;
      const candidate = JSON.parse(opened.text);
      const issues = validatePricing(candidate);
      if (issues.length) throw new Error(issues.join('; '));
      pricingEntry = {
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        ino: stat.ino,
        value: candidate,
        error: null,
      };
    } catch (err) {
      const next = {
        mtimeMs: stat?.mtimeMs ?? null,
        ctimeMs: stat?.ctimeMs ?? null,
        size: stat?.size ?? null,
        ino: stat?.ino ?? null,
        value: null,
        error: err instanceof Error ? err.message : String(err),
      };
      if (pricingEntry?.error !== next.error) logger.warn(`pricing disabled: ${next.error}`);
      pricingEntry = next;
    }
    return pricingEntry;
  }

  function buildState() {
    const now = Date.now();
    const maximumActivity = now + FUTURE_TIMESTAMP_TOLERANCE_MS;
    const cutoff = Number.isFinite(config.days)
      ? calendarWindowStart(now, config.days).getTime()
      : -Infinity;
    const sessions = [];
    const roots = new Set();
    const liveFiles = new Set();
    const revisionParts = [];
    let totalBytes = 0;
    let totalEvents = 0;
    const diagnostics = {
      filesDiscovered: 0,
      filesParsed: 0,
      filesFromCache: 0,
      filesUnreadable: 0,
      filesTooLarge: 0,
      filesRejectedSymlink: 0,
      filesOutsideRoot: 0,
      filesSkippedByteBudget: 0,
      fileBudgetReached: false,
      sessionBudgetReached: false,
      eventBudgetReached: false,
      sessionsSkippedEventBudget: 0,
      bytesAccepted: 0,
      eventsAccepted: 0,
      malformedLines: 0,
      invalidRows: 0,
      rowErrors: 0,
      orphanResults: 0,
      invalidSessionIds: 0,
      sessionsOutsideWindow: 0,
      sessionsWithoutTimestamps: 0,
      futureSessions: 0,
      ambiguousSpawnLinks: 0,
      cyclicSpawnLinks: 0,
      adapterErrors: 0,
      refreshThrottled: 0,
      pricingError: null,
    };

    const pricing = loadPricing();
    diagnostics.pricingError = pricing.error;
    revisionParts.push(`pricing:${pricing.mtimeMs}:${pricing.ctimeMs}:${pricing.ino}:${pricing.size}:${pricing.error ?? ''}`);

    scanAdapters:
    for (const adapter of adapters) {
      for (const desc of adapter.findFiles()) {
        if (diagnostics.filesDiscovered >= limits.maxFiles) {
          diagnostics.fileBudgetReached = true;
          break scanAdapters;
        }
        diagnostics.filesDiscovered++;
        let stat;
        try {
          stat = fs.lstatSync(desc.file);
        } catch {
          diagnostics.filesUnreadable++;
          continue;
        }
        if (stat.isSymbolicLink()) {
          diagnostics.filesRejectedSymlink++;
          continue;
        }
        if (!stat.isFile()) {
          diagnostics.filesUnreadable++;
          continue;
        }
        const sourceRoot = desc.root ?? path.dirname(desc.file);
        if (!isRealPathWithin(sourceRoot, desc.file)) {
          diagnostics.filesOutsideRoot++;
          continue;
        }
        if (stat.size > limits.maxFileBytes) {
          diagnostics.filesTooLarge++;
          continue;
        }
        if (totalBytes + stat.size > limits.maxTotalBytes) {
          diagnostics.filesSkippedByteBudget++;
          continue;
        }
        totalBytes += stat.size;
        diagnostics.bytesAccepted = totalBytes;
        liveFiles.add(desc.file);
        roots.add(`${adapter.source}: ${shortPath(sourceRoot)}`);
        revisionParts.push(`${adapter.source}:${desc.file}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`);
        let entry = fileCache.get(desc.file);
        if (
          !entry
          || entry.mtimeMs !== stat.mtimeMs
          || entry.ctimeMs !== stat.ctimeMs
          || entry.ino !== stat.ino
          || entry.dev !== stat.dev
          || entry.size !== stat.size
          || entry.source !== adapter.source
        ) {
          try {
            const result = adapter.parseFile(desc);
            entry = {
              source: adapter.source,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              ino: stat.ino,
              dev: stat.dev,
              size: stat.size,
              sessions: Array.isArray(result) ? result : result.sessions,
              diagnostics: Array.isArray(result) ? null : result.diagnostics,
            };
            diagnostics.filesParsed++;
          } catch (err) {
            entry = {
              source: adapter.source,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              ino: stat.ino,
              dev: stat.dev,
              size: stat.size,
              sessions: [],
              diagnostics: { readError: err instanceof Error ? err.message : String(err) },
            };
            diagnostics.adapterErrors++;
          }
          fileCache.set(desc.file, entry);
        } else {
          diagnostics.filesFromCache++;
        }

        const fileDiagnostics = entry.diagnostics;
        if (fileDiagnostics?.readError) diagnostics.filesUnreadable++;
        if (fileDiagnostics?.tooLarge) diagnostics.filesTooLarge++;
        diagnostics.malformedLines += fileDiagnostics?.malformedLines ?? 0;
        diagnostics.invalidRows += fileDiagnostics?.invalidRows ?? 0;
        diagnostics.rowErrors += fileDiagnostics?.rowErrors ?? 0;
        diagnostics.orphanResults += fileDiagnostics?.orphanResults ?? 0;
        diagnostics.invalidSessionIds += fileDiagnostics?.invalidSessionIds ?? 0;
        diagnostics.filesRejectedSymlink += fileDiagnostics?.symlinkRejected ? 1 : 0;

        for (const session of entry.sessions) {
          if (sessions.length >= limits.maxSessions) {
            diagnostics.sessionBudgetReached = true;
            break scanAdapters;
          }
          if (typeof session.id !== 'string' || !session.id || session.id.length > 512) {
            diagnostics.invalidSessionIds++;
            continue;
          }
          const hasFutureActivity = hasSessionActivityAfter(session, maximumActivity);
          const activity = latestSessionMs(session, maximumActivity);
          if (activity == null) {
            if (hasFutureActivity) diagnostics.futureSessions++;
            else diagnostics.sessionsWithoutTimestamps++;
            if (hasFutureActivity || Number.isFinite(config.days)) continue;
          } else if (hasFutureActivity) {
            diagnostics.futureSessions++;
          }
          if (activity != null && activity < cutoff) {
            diagnostics.sessionsOutsideWindow++;
            continue;
          }
          if (totalEvents + session.events.length > limits.maxEvents) {
            diagnostics.eventBudgetReached = true;
            diagnostics.sessionsSkippedEventBudget++;
            continue;
          }
          session.key = publicKey(session);
          sessions.push(session);
          totalEvents += session.events.length;
          diagnostics.eventsAccepted = totalEvents;
        }
      }
    }
    for (const file of fileCache.keys()) if (!liveFiles.has(file)) fileCache.delete(file);

    const byKey = new Map(sessions.map((session) => [session.key, session]));
    const relationshipScope = (session) => session.linkScope ?? session.file;
    const byScopedId = new Map(sessions.map((session) => [
      `${session.source}\0${relationshipScope(session)}\0${session.id.toLowerCase()}`,
      session,
    ]));
    const byRawId = new Map();
    for (const session of sessions) {
      const raw = session.id.toLowerCase();
      if (!byRawId.has(raw)) byRawId.set(raw, []);
      byRawId.get(raw).push(session);
      session.parent = null;
      session.children = [];
      for (const event of session.events) {
        if (event.kind === 'tool') delete event.tool.spawnTarget;
      }
    }

    const createsCycle = (parent, child) => {
      for (let current = parent; current; current = current.parent ? byKey.get(current.parent) : null) {
        if (current === child) return true;
      }
      return false;
    };

    for (const session of sessions) {
      if (session.intrinsicParent) {
        const parentId = typeof session.intrinsicParent === 'string' ? session.intrinsicParent.toLowerCase() : null;
        const parent = parentId
          ? byScopedId.get(`${session.source}\0${relationshipScope(session)}\0${parentId}`)
          : null;
        if (parent && !createsCycle(parent, session)) {
          session.parent = parent.key;
          if (!parent.children.includes(session.key)) parent.children.push(session.key);
        } else if (parent) {
          diagnostics.cyclicSpawnLinks++;
        }
      }
      for (const event of session.events) {
        const eventTimestamp = parsedTimestamp(event.ts);
        if (eventTimestamp != null && eventTimestamp > maximumActivity) continue;
        const targetId = event.kind === 'tool' ? event.tool.intrinsicSpawnTarget : null;
        if (typeof targetId !== 'string' || !targetId) continue;
        const target = byScopedId.get(`${session.source}\0${relationshipScope(session)}\0${targetId.toLowerCase()}`);
        if (target) event.tool.spawnTarget = target.key;
      }
    }

    for (const session of sessions) {
      for (const { uuid, ev, ts } of session.spawnCandidates) {
        if (typeof uuid !== 'string') continue;
        const eventTimestamp = parsedTimestamp(ev?.ts);
        const candidateTimestamp = parsedTimestamp(ts);
        if (
          (eventTimestamp != null && eventTimestamp > maximumActivity)
          || (candidateTimestamp != null && candidateTimestamp > maximumActivity)
        ) continue;
        let candidates = byRawId.get(uuid.toLowerCase()) ?? [];
        const sameSource = candidates.filter((candidate) => candidate.source === session.source);
        if (sameSource.length) candidates = sameSource;
        candidates = candidates.filter((candidate) => candidate !== session);
        if (candidates.length !== 1) {
          if (candidates.length > 1) diagnostics.ambiguousSpawnLinks++;
          continue;
        }
        const child = candidates[0];
        if (!child.parent && !createsCycle(session, child)) {
          child.parent = session.key;
          if (!session.children.includes(child.key)) session.children.push(child.key);
        } else if (!child.parent) {
          diagnostics.cyclicSpawnLinks++;
          continue;
        }
        ev.tool.spawnTarget ??= child.key;
      }
    }

    revisionParts.sort();
    const analysisByKey = new Map(
      sessions.map((session) => [
        session.key,
        sessionIntelligence(session, pricing.value, {
          now,
          maximumTimestamp: maximumActivity,
        }),
      ]),
    );
    return {
      scannedAt: now,
      roots: [...roots].sort(),
      sessions,
      byKey,
      analysisByKey,
      pricing: pricing.value,
      diagnostics,
      revision: crypto.createHash('sha256').update(revisionParts.join('\n')).digest('hex').slice(0, 20),
    };
  }

  function getState(force = false, throttle = false) {
    const now = Date.now();
    if (snapshot) {
      const age = now - snapshot.createdAt;
      if (force && throttle && age < limits.minRefreshMs) {
        snapshot.state.diagnostics.refreshThrottled++;
        return snapshot.state;
      }
      if (!force && age < Math.max(SNAPSHOT_TTL_MS, limits.minRefreshMs)) {
        return snapshot.state;
      }
    }
    const state = buildState();
    snapshot = { createdAt: now, state };
    return state;
  }

  function filteredState(source, force = false) {
    const state = getState(force, true);
    const sessions = source && source !== 'all'
      ? state.sessions.filter((session) => session.source === source)
      : state.sessions;
    const counts = {};
    for (const session of state.sessions) counts[session.source] = (counts[session.source] || 0) + 1;
    return { ...state, sessions, counts };
  }

  const server = http.createServer((req, res) => {
    const headOnly = req.method === 'HEAD';
    try {
      const address = server.address();
      const listeningPort = address && typeof address === 'object'
        ? address.port
        : config.port;
      if (!isAllowedHost(req.headers.host, listeningPort) || !isAllowedOrigin(req.headers.origin, listeningPort)) {
        return json(res, { error: 'forbidden host or origin' }, 403, headOnly);
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${listeningPort}`);
      if (url.pathname.startsWith('/api/') && !isRequestAuthorized(req.headers, apiToken, listeningPort)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="runlume"');
        return json(res, { error: 'authentication required' }, 401, headOnly);
      }
      if (req.method !== 'GET' && !headOnly) {
        res.setHeader('Allow', 'GET, HEAD');
        return json(res, { error: 'method not allowed' }, 405);
      }

      const source = url.searchParams.get('source');
      const force = url.searchParams.get('refresh') === '1';
      if (
        url.pathname.startsWith('/api/')
        && source
        && source !== 'all'
        && !adapters.some((adapter) => adapter.source === source)
      ) {
        return json(res, { error: 'unknown or disabled source' }, 400, headOnly);
      }

      if (url.pathname === '/api/dashboard') {
        const state = filteredState(source, force);
        const apiSessions = sessionsForApi(state.sessions, state.analysisByKey);
        return json(res, {
          roots: redactedRoots(state.roots),
          sources: adapters.map((adapter) => adapter.source),
          counts: state.counts,
          revision: state.revision,
          diagnostics: redactedDiagnostics(state.diagnostics),
          generatedAt: new Date(state.scannedAt).toISOString(),
          ...apiSessions,
          stats: redactedStats(buildStats(state.sessions, {
            days: config.days,
            pricing: state.pricing,
            analysisByKey: state.analysisByKey,
            now: state.scannedAt,
          })),
        }, 200, headOnly);
      }
      if (url.pathname === '/api/state') {
        const state = filteredState(source, force);
        const apiSessions = sessionsForApi(state.sessions, state.analysisByKey);
        return json(res, {
          roots: redactedRoots(state.roots),
          sources: adapters.map((adapter) => adapter.source),
          counts: state.counts,
          revision: state.revision,
          diagnostics: redactedDiagnostics(state.diagnostics),
          generatedAt: new Date(state.scannedAt).toISOString(),
          ...apiSessions,
        }, 200, headOnly);
      }
      if (url.pathname === '/api/stats') {
        const state = filteredState(source, force);
        return json(res, redactedStats(buildStats(state.sessions, {
          days: config.days,
          pricing: state.pricing,
          analysisByKey: state.analysisByKey,
          now: state.scannedAt,
        })), 200, headOnly);
      }
      if (url.pathname === '/api/session') {
        const state = getState(force, true);
        const eligibleSessions = source && source !== 'all'
          ? state.sessions.filter((candidate) => candidate.source === source)
          : state.sessions;
        const key = url.searchParams.get('key');
        let session = key
          ? eligibleSessions.find((candidate) => candidate.key === key)
          : null;
        if (!session) {
          const id = (url.searchParams.get('id') || '').toLowerCase();
          const matches = eligibleSessions.filter((candidate) => candidate.id.toLowerCase() === id);
          if (matches.length > 1) return json(res, { error: 'session id is ambiguous; use key' }, 409, headOnly);
          session = matches[0];
        }
        if (!session) return json(res, { error: 'session not found' }, 404, headOnly);
        const page = paginationFrom(url);
        if (!page) return json(res, { error: `offset must be non-negative and limit must be 1-${MAX_EVENT_PAGE_LIMIT}` }, 400, headOnly);
        const view = url.searchParams.get('view') ?? 'redacted';
        if (view !== 'redacted' && view !== 'raw') {
          return json(res, { error: 'view must be redacted or raw' }, 400, headOnly);
        }
        return json(res, sessionPageForApi(session, state.pricing, {
          ...page,
          revealSensitive: view === 'raw',
          analysis: state.analysisByKey.get(session.key),
        }), 200, headOnly);
      }

      let relative;
      try {
        relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      } catch {
        return json(res, { error: 'malformed URL path' }, 400, headOnly);
      }
      const filePath = path.resolve(STATIC_ROOT, relative);
      const withinStaticRoot = filePath === STATIC_ROOT || filePath.startsWith(`${STATIC_ROOT}${path.sep}`);
      let staticStat = null;
      try { staticStat = withinStaticRoot ? fs.lstatSync(filePath) : null; } catch { /* handled as not found */ }
      if (
        withinStaticRoot
        && staticStat?.isFile()
        && !staticStat.isSymbolicLink()
        && isRealPathWithin(STATIC_ROOT, filePath)
      ) {
        const body = fs.readFileSync(filePath);
        const headers = {
          ...securityHeaders(MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'no-cache'),
          'Content-Length': body.length,
        };
        if (relative.toLowerCase() === 'index.html' && isDocumentNavigation(req)) {
          headers['Set-Cookie'] = `${browserCookieName(listeningPort)}=${browserCookieToken(apiToken)}; HttpOnly; SameSite=Strict; Path=/`;
        }
        res.writeHead(200, headers);
        return res.end(headOnly ? undefined : body);
      }
      return json(res, { error: 'not found' }, 404, headOnly);
    } catch (err) {
      const incident = crypto.randomBytes(6).toString('hex');
      logger.error(`request failed [${incident}]: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return json(res, { error: `internal server error (${incident})` }, 500, headOnly);
    }
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return { server, getState, adapters, apiToken };
}

export function start(config, logger = console) {
  const dashboard = createDashboard({ config, logger });
  const { server } = dashboard;
  server.on('error', (err) => {
    logger.error(`server failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
  server.listen(config.port, '127.0.0.1', () => {
    const address = server.address();
    const listeningPort = address && typeof address === 'object' ? address.port : config.port;
    const started = Date.now();
    const state = dashboard.getState(true);
    const bySource = {};
    for (const session of state.sessions) bySource[session.source] = (bySource[session.source] || 0) + 1;
    logger.log(`RunLume running at http://127.0.0.1:${listeningPort}/`);
    logger.log(`sources: ${dashboard.adapters.map((adapter) => adapter.source).join(', ')} | window: ${Number.isFinite(config.days) ? `sessions active in the last ${config.days} days` : 'all history'}`);
    logger.log(`sessions: ${state.sessions.length} ${JSON.stringify(bySource)} (initial scan ${Date.now() - started}ms)`);
    if (!state.sessions.length) logger.log('No sessions found. Run "npm run sample" for demo data, or pass --all to scan all history.');
    const diagnosticIssues = state.diagnostics.malformedLines
      + state.diagnostics.invalidRows
      + state.diagnostics.rowErrors
      + state.diagnostics.filesUnreadable
      + state.diagnostics.filesTooLarge
      + state.diagnostics.adapterErrors;
    if (diagnosticIssues) logger.warn(`data quality: ${JSON.stringify(state.diagnostics)}`);
  });
  return dashboard;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(__filename);
  } catch {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(HELP);
  } else if (args.includes('--version')) {
    console.log(PACKAGE.version);
  } else {
    try {
      start(parseConfig(args));
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}\n\n${HELP}`);
      process.exitCode = 1;
    }
  }
}
