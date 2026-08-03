import path from 'node:path';
import {
  median,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  EDIT_TOOLS,
  dayKey,
  calendarWindowStart,
  inferProvider,
  MAX_ANALYTICS_PATH_LENGTH,
  GIT_PATCH_PATH,
  CORRECTION_RE,
  analyticsTimestampMs,
  timestampIsAfter,
  tokenCount,
  tokenSum,
  PROVIDER_ALIASES,
  lineCount,
  canonicalProjectPath,
  isCaseInsensitiveProjectPath,
  cleanFilePath,
  decodeGitQuotedPath,
  patchHeaderPath,
  gitDiffPaths,
  sessionProject,
  linesOf,
} from './shared.mjs';
import {
  diffLineCounts,
  PATCH_WRAPPER_TOOLS,
  MAX_PATCH_WRAPPER_SOURCE_LENGTH,
  MAX_PATCH_INVOCATIONS,
  looksLikePatch,
  directPatchText,
  executableText,
  hasLocalApplyPatchDeclaration,
  shellTokens,
  heredocBody,
  shellCommandInfo,
  collectShellPatches,
  decodeStaticString,
  lexicalScopes,
  scopeAt,
  bindingEntryBefore,
  bindingBefore,
  staticAssignments,
  staticInvocationArgument,
  patchBudget,
  collectJavaScriptPatches,
  wrappedPatchTexts,
} from './impact.mjs';
import {
  parsePatch,
  extractEditOperations,
  stringEdit,
  validIsoDay,
  effectiveInterval,
  findIntervalOverlap,
  pricingOverlapIssues,
} from './patch.mjs';
import {
  validatePricing,
  priceSession,
  modelMatchesRate,
  rateFor,
  publicRate,
  priceUsageEntry,
} from './pricing.mjs';
export function sessionIntelligence(session, pricing, {
  now = Date.now(),
  maximumTimestamp = now + FUTURE_TIMESTAMP_TOLERANCE_MS,
} = {}) {
  const files = new Map();
  const edits = [];
  const toolLatencies = [];
  const events = [];
  let futureEventsOmitted = 0;
  let startedMs = null;
  let endedMs = null;
  const admitTime = (value) => {
    const parsed = analyticsTimestampMs(value);
    if (parsed == null || parsed > maximumTimestamp) return;
    if (startedMs == null || parsed < startedMs) startedMs = parsed;
    if (endedMs == null || parsed > endedMs) endedMs = parsed;
  };
  admitTime(session.startedAt);
  admitTime(session.endedAt);
  for (const rawEvent of session.events) {
    if (timestampIsAfter(rawEvent.ts, maximumTimestamp)) {
      futureEventsOmitted++;
      continue;
    }
    admitTime(rawEvent.ts);
    if (rawEvent.kind === 'tool' && timestampIsAfter(rawEvent.tool?.resultTs, maximumTimestamp)) {
      futureEventsOmitted++;
      events.push({
        ...rawEvent,
        tool: {
          ...rawEvent.tool,
          result: null,
          resultTs: null,
          isError: false,
          confirmed: false,
        },
      });
    } else {
      if (rawEvent.kind === 'tool') admitTime(rawEvent.tool?.resultTs);
      events.push(rawEvent);
    }
  }
  const users = events.filter((e) => e.kind === 'user');
  let toolCalls = 0;
  let toolErrors = 0;
  let attemptedEditOperations = 0;
  let confirmedEditCalls = 0;
  let failedEditOperations = 0;
  let unconfirmedEditOperations = 0;
  let firstEditAt = null;

  for (const ev of events) {
    if (ev.kind !== 'tool') continue;
    toolCalls++;
    if (ev.tool.isError) toolErrors++;
    if (ev.ts && ev.tool.resultTs) {
      const ms = Date.parse(ev.tool.resultTs) - Date.parse(ev.ts);
      if (ms >= 0 && ms < 86_400_000) toolLatencies.push(ms);
    }
    const attemptedOps = extractEditOperations(ev, session.cwd);
    if (!attemptedOps.length) continue;
    attemptedEditOperations += attemptedOps.length;
    if (ev.tool.isError) {
      failedEditOperations += attemptedOps.length;
      continue;
    }
    if ((ev.tool.result == null || ev.tool.resultTs == null) && ev.tool.confirmed !== true) {
      unconfirmedEditOperations += attemptedOps.length;
      continue;
    }
    confirmedEditCalls++;
    const ops = attemptedOps;
    firstEditAt ??= ev.ts;
    for (const op of ops) {
      edits.push({ ...op, ts: ev.ts });
      const rec = files.get(op.path) ?? { path: op.path, additions: 0, deletions: 0, edits: 0, estimated: false };
      rec.additions += op.additions;
      rec.deletions += op.deletions;
      rec.edits++;
      rec.estimated ||= Boolean(op.estimated);
      files.set(op.path, rec);
    }
  }

  const corrections = users.slice(1).filter((e) => CORRECTION_RE.test(e.text ?? '')).length;
  const firstUserAt = users.find((e) => e.ts)?.ts ?? null;
  let timeToFirstEditMs = null;
  if (firstUserAt && firstEditAt) {
    const ms = Date.parse(firstEditAt) - Date.parse(firstUserAt);
    if (ms >= 0 && ms < 86_400_000) timeToFirstEditMs = ms;
  }
  let last = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.kind === 'user' || event.kind === 'assistant' || event.kind === 'tool') {
      last = event;
      break;
    }
  }
  const liveAge = endedMs == null ? null : now - endedMs;
  const isLive = liveAge != null
    && liveAge >= -FUTURE_TIMESTAMP_TOLERANCE_MS
    && liveAge < FUTURE_TIMESTAMP_TOLERANCE_MS;
  const abandoned = Boolean(users.length && last?.kind !== 'assistant' && !isLive);
  const reworkLoops = [...files.values()].reduce((n, f) => n + Math.max(0, f.edits - 1), 0);
  const cost = priceSession(session, pricing, {
    maximumTimestamp,
    fallbackTimestamp: startedMs == null ? null : new Date(startedMs).toISOString(),
  });
  const eventToolCounts = Object.fromEntries(
    [...events
      .filter((event) => event.kind === 'tool')
      .reduce((counts, event) => {
        counts.set(event.tool.name, (counts.get(event.tool.name) ?? 0) + 1);
        return counts;
      }, new Map())],
  );
  const observed = {
    tokensIn: cost.breakdown.reduce((sum, entry) => tokenSum(sum, entry.input), 0),
    tokensOut: cost.breakdown.reduce((sum, entry) => tokenSum(sum, entry.output), 0),
    tokensCacheRead: cost.breakdown.reduce((sum, entry) => tokenSum(sum, entry.cacheRead), 0),
    tokensCacheWrite: cost.breakdown.reduce((sum, entry) => tokenSum(sum, entry.cacheWrite), 0),
    messages: events.filter((event) => event.kind === 'user' || event.kind === 'assistant').length,
    errors: toolErrors,
    toolCounts: futureEventsOmitted
      ? eventToolCounts
      : session.stats?.toolCounts ?? eventToolCounts,
  };
  return {
    events,
    futureEventsOmitted,
    startedMs,
    endedMs,
    observed,
    edits,
    files: [...files.values()],
    editOperations: edits.length,
    attemptedEditOperations,
    confirmedEditCalls,
    failedEditOperations,
    unconfirmedEditOperations,
    estimatedOperations: edits.filter((edit) => edit.estimated).length,
    changedLines: edits.reduce((n, e) => n + e.additions + e.deletions, 0),
    additions: edits.reduce((n, e) => n + e.additions, 0),
    deletions: edits.reduce((n, e) => n + e.deletions, 0),
    reworkLoops,
    corrections,
    abandoned,
    timeToFirstEditMs,
    toolCalls,
    toolErrors,
    toolLatencies,
    medianToolLatencyMs: median(toolLatencies),
    cost,
  };
}

function sourceAggregate(source) {
  return {
    source, sessions: 0, edits: 0, changedLines: 0, outputTokens: 0, inputTokens: 0,
    cacheRead: 0, toolCalls: 0, toolErrors: 0, toolLatencies: [], apiCost: 0,
    pricedSessions: 0, pricedEdits: 0, pricedChangedLines: 0,
    corrections: 0, reworkLoops: 0, abandoned: 0, firstEditTimes: [],
  };
}

function finalizeSource(row) {
  const cacheDenom = Math.max(0, row.inputTokens);
  return {
    source: row.source,
    sessions: row.sessions,
    edits: row.edits,
    changedLines: row.changedLines,
    apiCost: row.apiCost,
    pricedSessions: row.pricedSessions,
    editsPerSession: row.sessions ? row.edits / row.sessions : null,
    outputTokensPerEdit: row.edits ? row.outputTokens / row.edits : null,
    toolErrorRate: row.toolCalls ? row.toolErrors / row.toolCalls : null,
    medianToolLatencyMs: median(row.toolLatencies),
    cacheEfficiency: cacheDenom ? row.cacheRead / cacheDenom : null,
    costPerEdit: row.pricedEdits ? row.apiCost / row.pricedEdits : null,
    costPer100Lines: row.pricedChangedLines ? row.apiCost / row.pricedChangedLines * 100 : null,
    correctionsPerSession: row.sessions ? row.corrections / row.sessions : null,
    reworkPerSession: row.sessions ? row.reworkLoops / row.sessions : null,
    abandonedRate: row.sessions ? row.abandoned / row.sessions : null,
    medianTimeToFirstEditMs: median(row.firstEditTimes),
    samples: {
      sessions: row.sessions,
      edits: row.edits,
      changedLines: row.changedLines,
      toolCalls: row.toolCalls,
      toolLatencies: row.toolLatencies.length,
      pricedSessions: row.pricedSessions,
      pricedEdits: row.pricedEdits,
      timeToFirstEdit: row.firstEditTimes.length,
    },
  };
}

function providerAggregate(provider) {
  return {
    provider,
    sessionIds: new Set(),
    sources: new Set(),
    models: new Set(),
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    apiCost: 0,
    billableTokens: 0,
    pricedTokens: 0,
    pricedRequests: 0,
  };
}

function finalizeProvider(row) {
  return {
    provider: row.provider,
    sessions: row.sessionIds.size,
    sources: [...row.sources].sort(),
    models: [...row.models].sort(),
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.inputTokens + row.outputTokens,
    cacheRead: row.cacheRead,
    cacheEfficiency: row.inputTokens ? row.cacheRead / row.inputTokens : null,
    apiCost: row.pricedRequests ? row.apiCost : null,
    billableTokens: row.billableTokens,
    pricedTokens: row.pricedTokens,
    pricingCoverage: row.billableTokens
      ? row.pricedTokens / row.billableTokens
      : row.pricedRequests ? 1 : null,
  };
}

function riskLevel(score) {
  return score >= 65 ? 'high' : score >= 30 ? 'watch' : 'low';
}

export {
  sourceAggregate,
  finalizeSource,
  providerAggregate,
  finalizeProvider,
  riskLevel,
};
