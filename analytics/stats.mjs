import path from 'node:path';
import {
  median,
  dayKey,
  calendarWindowStart,
  inferProvider,
  tokenSum,
  isCaseInsensitiveProjectPath,
  sessionProject,
} from './shared.mjs';

import {
  sessionIntelligence,
  sourceAggregate,
  finalizeSource,
  providerAggregate,
  finalizeProvider,
  riskLevel,
} from './workflow.mjs';
export function buildStats(
  sessions,
  {
    days = 30,
    pricing = null,
    analysisByKey = null,
    now = Date.now(),
  } = {},
) {
  const perDay = new Map();
  const day = (k) => {
    if (!k) return null;
    if (!perDay.has(k)) perDay.set(k, { date: k, toolCalls: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensCacheWrite: 0, sessions: 0, errors: 0, additions: 0, deletions: 0, edits: 0, apiCost: 0 });
    return perDay.get(k);
  };
  const punch = Array.from({ length: 7 }, () => Array(24).fill(0));
  const tools = new Map();
  const models = new Map();
  const files = new Map();
  const directories = new Map();
  const sources = new Map();
  const providers = new Map();
  const totals = {
    sessions: sessions.length, spawns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0,
    cacheRead: 0, cacheWrite: 0, errors: 0, edits: 0, editCalls: 0, messages: 0,
    additions: 0, deletions: 0, changedLines: 0, filesTouched: 0, estimatedEdits: 0,
    attemptedEdits: 0, failedEdits: 0, unconfirmedEdits: 0,
  };
  const sessionRows = [];
  let longest = null;

  for (const session of sessions) {
    const intel = analysisByKey?.get(session.key) ?? sessionIntelligence(session, pricing, { now });
    const source = sources.get(session.source) ?? sourceAggregate(session.source);
    sources.set(session.source, source);
    source.sessions++;
    source.edits += intel.editOperations;
    source.changedLines += intel.changedLines;
    source.outputTokens = tokenSum(source.outputTokens, intel.observed.tokensOut);
    source.inputTokens = tokenSum(source.inputTokens, intel.observed.tokensIn);
    source.cacheRead = tokenSum(source.cacheRead, intel.observed.tokensCacheRead);
    source.toolCalls += intel.toolCalls;
    source.toolErrors += intel.toolErrors;
    for (const latency of intel.toolLatencies) source.toolLatencies.push(latency);
    source.corrections += intel.corrections;
    source.reworkLoops += intel.reworkLoops;
    source.abandoned += Number(intel.abandoned);
    if (intel.timeToFirstEditMs != null) source.firstEditTimes.push(intel.timeToFirstEditMs);
    if (intel.cost.total != null) {
      source.apiCost += intel.cost.total;
      source.pricedSessions++;
      source.pricedEdits += intel.editOperations;
      source.pricedChangedLines += intel.changedLines;
    }

    const sessionIdentity = session.key
      ?? `${session.source}\0${session.file ?? ''}\0${session.id}`;
    for (const usage of intel.cost.breakdown) {
      const providerId = inferProvider(usage.model, session.source, session.provider);
      const provider = providers.get(providerId) ?? providerAggregate(providerId);
      provider.sessionIds.add(sessionIdentity);
      provider.sources.add(session.source);
      provider.models.add(usage.model || session.model || '(unknown model)');
      provider.requests++;
      provider.inputTokens = tokenSum(provider.inputTokens, usage.input);
      provider.outputTokens = tokenSum(provider.outputTokens, usage.output);
      provider.cacheRead = tokenSum(provider.cacheRead, usage.cacheRead);
      provider.billableTokens = tokenSum(provider.billableTokens, usage.billableTokens);
      if (usage.total != null) {
        provider.apiCost += usage.total;
        provider.pricedTokens = tokenSum(provider.pricedTokens, usage.billableTokens);
        provider.pricedRequests++;
      }
      providers.set(providerId, provider);
    }

    totals.spawns += session.children.length;
    totals.tokensIn = tokenSum(totals.tokensIn, intel.observed.tokensIn);
    totals.tokensOut = tokenSum(totals.tokensOut, intel.observed.tokensOut);
    totals.cacheRead = tokenSum(totals.cacheRead, intel.observed.tokensCacheRead);
    totals.cacheWrite = tokenSum(totals.cacheWrite, intel.observed.tokensCacheWrite);
    totals.errors += intel.toolErrors;
    totals.messages += intel.observed.messages;
    totals.edits += intel.editOperations;
    totals.editCalls += intel.confirmedEditCalls;
    totals.attemptedEdits += intel.attemptedEditOperations;
    totals.failedEdits += intel.failedEditOperations;
    totals.unconfirmedEdits += intel.unconfirmedEditOperations;
    totals.estimatedEdits += intel.estimatedOperations;
    totals.additions += intel.additions;
    totals.deletions += intel.deletions;
    totals.changedLines += intel.changedLines;

    const usageModels = new Set(intel.cost.breakdown.map((entry) => entry.model || '(unknown model)'));
    if (!usageModels.size) usageModels.add(session.model || '(unknown model)');
    for (const modelKey of usageModels) {
      const pricedForModel = intel.cost.breakdown.filter((entry) => (entry.model || '(unknown model)') === modelKey && entry.total != null);
      const model = models.get(modelKey) ?? {
        name: modelKey,
        sessions: 0,
        apiCost: 0,
        pricedSessions: 0,
        rates: [],
      };
      model.sessions++;
      if (pricedForModel.length) {
        model.apiCost += pricedForModel.reduce((sum, entry) => sum + entry.total, 0);
        model.pricedSessions++;
        for (const entry of pricedForModel) {
          const rateKey = [
            entry.rate.id,
            entry.rate.effectiveFrom ?? '',
            entry.rate.effectiveTo ?? '',
          ].join('\0');
          if (!model.rates.some((rate) => rate.key === rateKey)) {
            model.rates.push({ key: rateKey, value: entry.rate });
          }
        }
      }
      models.set(modelKey, model);
    }

    const startedDay = day(intel.startedMs == null ? null : dayKey(new Date(intel.startedMs)));
    if (startedDay) {
      startedDay.sessions++;
    }
    for (const usage of intel.cost.breakdown) {
      const usageDay = day(dayKey(usage.ts) ?? dayKey(session.startedAt));
      if (!usageDay) continue;
      usageDay.tokensIn = tokenSum(usageDay.tokensIn, usage.input);
      usageDay.tokensOut = tokenSum(usageDay.tokensOut, usage.output);
      usageDay.tokensCache = tokenSum(usageDay.tokensCache, usage.cacheRead);
      usageDay.tokensCacheWrite = tokenSum(usageDay.tokensCacheWrite, usage.cacheWrite);
      if (usage.total != null) usageDay.apiCost += usage.total;
    }
    if (intel.startedMs != null && intel.endedMs != null) {
      const ms = intel.endedMs - intel.startedMs;
      if (ms > 0 && ms < 86_400_000 && (!longest || ms > longest.ms)) longest = { ms, label: session.label, id: session.id };
    }

    const project = sessionProject(session);
    const caseInsensitiveProject = isCaseInsensitiveProjectPath(project);
    for (const edit of intel.edits) {
      const k = dayKey(edit.ts) ?? dayKey(session.startedAt);
      const d = day(k);
      if (d) { d.additions += edit.additions; d.deletions += edit.deletions; d.edits++; }
      const projectKey = caseInsensitiveProject ? project.toLowerCase() : project;
      const editKey = caseInsensitiveProject ? edit.path.toLowerCase() : edit.path;
      const fileKey = `${projectKey}\0${editKey}`;
      const f = files.get(fileKey) ?? {
        project,
        path: edit.path,
        additions: 0,
        deletions: 0,
        edits: 0,
        estimated: false,
        sessionIds: new Set(),
        sources: new Set(),
      };
      f.additions += edit.additions;
      f.deletions += edit.deletions;
      f.edits++;
      f.estimated ||= Boolean(edit.estimated);
      f.sessionIds.add(sessionIdentity);
      f.sources.add(session.source);
      files.set(fileKey, f);
    }

    sessionRows.push({
      id: session.id, source: session.source, label: session.label, model: session.model,
      provider: inferProvider(session.model, session.source, session.provider),
      runtime: session.runtime,
      apiCost: intel.cost.total, rate: intel.cost.rate, edits: intel.editOperations,
      changedLines: intel.changedLines, reworkLoops: intel.reworkLoops, corrections: intel.corrections,
      abandoned: intel.abandoned, timeToFirstEditMs: intel.timeToFirstEditMs,
      pricingPartial: intel.cost.isPartial,
      billableTokens: intel.cost.billableTokens,
      pricedTokens: intel.cost.pricedTokens,
    });

    for (const ev of intel.events) {
      if (!ev.ts) continue;
      const t = new Date(ev.ts);
      if (!Number.isNaN(t.getTime()) && (ev.kind === 'tool' || ev.kind === 'assistant')) punch[t.getDay()][t.getHours()]++;
      if (ev.kind !== 'tool') continue;
      totals.toolCalls++;
      const d = day(dayKey(ev.ts));
      if (d) {
        d.toolCalls++;
        if (ev.tool.isError) d.errors++;
      }
      const rec = tools.get(ev.tool.name) || { name: ev.tool.name, count: 0, errors: 0 };
      rec.count++;
      if (ev.tool.isError) rec.errors++;
      tools.set(ev.tool.name, rec);
    }
  }

  totals.filesTouched = files.size;
  const fileRows = [...files.values()].map((f) => {
    const sessionsTouched = f.sessionIds.size;
    const churn = Math.max(0, sessionsTouched - 1) + Math.max(0, f.edits - sessionsTouched);
    const score = Math.round(Math.min(100,
      35 * Math.min(1, sessionsTouched / 4) + 25 * Math.min(1, f.edits / 8)
      + 25 * Math.min(1, churn / 6) + 15 * Math.min(1, (f.additions + f.deletions) / 500)));
    const directory = path.posix.dirname(f.path);
    const directoryKey = `${f.project}\0${directory}`;
    const dir = directories.get(directoryKey) ?? {
      project: f.project,
      path: directory,
      edits: 0,
      additions: 0,
      deletions: 0,
      files: new Set(),
      sessions: new Set(),
    };
    dir.edits += f.edits;
    dir.additions += f.additions;
    dir.deletions += f.deletions;
    dir.files.add(`${f.project}\0${f.path}`);
    for (const id of f.sessionIds) dir.sessions.add(id);
    directories.set(directoryKey, dir);
    return {
      project: f.project, path: f.path, directory, edits: f.edits, additions: f.additions, deletions: f.deletions,
      changedLines: f.additions + f.deletions, sessions: sessionsTouched, churn,
      sources: [...f.sources], riskScore: score, risk: riskLevel(score),
      estimated: f.estimated,
    };
  }).sort((a, b) => b.riskScore - a.riskScore || b.changedLines - a.changedLines);

  const directoryRows = [...directories.values()].map((d) => ({
    project: d.project, path: d.path, edits: d.edits, additions: d.additions, deletions: d.deletions,
    changedLines: d.additions + d.deletions, files: d.files.size, sessions: d.sessions.size,
  })).sort((a, b) => b.edits - a.edits || b.changedLines - a.changedLines);

  const keys = [...perDay.keys()].sort();
  const today = new Date(now);
  if (Number.isNaN(today.getTime())) throw new Error('statistics require a valid current date');
  const series = [];
  const emptyDay = (date) => ({ date, toolCalls: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensCacheWrite: 0, sessions: 0, errors: 0, additions: 0, deletions: 0, edits: 0, apiCost: 0 });
  const maxAllSeriesDays = 730;
  if (Number.isFinite(days)) {
    const start = calendarWindowStart(today, days);
    for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
      const k = dayKey(d);
      series.push(perDay.get(k) || emptyDay(k));
    }
  } else if (keys.length) {
    for (const key of keys.slice(-maxAllSeriesDays)) series.push(perDay.get(key));
  } else {
    series.push(emptyDay(dayKey(today)));
  }

  let peak = { weekday: 0, hour: 0, n: 0 };
  for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) if (punch[w][h] > peak.n) peak = { weekday: w, hour: h, n: punch[w][h] };
  const allDays = [...perDay.values()];
  const busiest = allDays.reduce((m, d) => (d.toolCalls > (m?.toolCalls || 0) ? d : m), null);
  const activeDays = allDays.filter((d) => d.toolCalls > 0 || d.sessions > 0 || d.tokensIn > 0 || d.tokensOut > 0).length;
  const windowFrom = Number.isFinite(days)
    ? series[0]?.date ?? dayKey(today)
    : keys[0] ?? series[0]?.date ?? dayKey(today);
  const windowTo = dayKey(today);
  const [fromYear, fromMonth, fromDate] = windowFrom.split('-').map(Number);
  const [toYear, toMonth, toDate] = windowTo.split('-').map(Number);
  const spanDays = Number.isFinite(days)
    ? Math.max(1, days)
    : Math.max(1, Math.round(
      (Date.UTC(toYear, toMonth - 1, toDate) - Date.UTC(fromYear, fromMonth - 1, fromDate))
      / 86_400_000,
    ) + 1);
  let streak = 0;
  for (let d = new Date(today.getFullYear(), today.getMonth(), today.getDate());;) {
    const row = perDay.get(dayKey(d));
    if (!row || !(row.toolCalls > 0 || row.sessions > 0 || row.tokensIn > 0 || row.tokensOut > 0)) break;
    streak++;
    d.setDate(d.getDate() - 1);
  }

  const apiCost = sessionRows.reduce((n, s) => n + (s.apiCost || 0), 0);
  const pricedSessions = sessionRows.filter((s) => s.apiCost != null).length;
  const fullyPricedSessions = sessionRows.filter((s) => s.apiCost != null && !s.pricingPartial).length;
  const partiallyPricedSessions = sessionRows.filter((s) => s.apiCost != null && s.pricingPartial).length;
  const pricedEdits = sessionRows.filter((s) => s.apiCost != null).reduce((n, s) => n + s.edits, 0);
  const billableTokens = sessionRows.reduce((n, s) => n + s.billableTokens, 0);
  const pricedTokens = sessionRows.reduce((n, s) => n + s.pricedTokens, 0);
  const workflow = {
    reworkLoops: sessionRows.reduce((n, s) => n + s.reworkLoops, 0),
    sessionsWithRework: sessionRows.filter((s) => s.reworkLoops > 0).length,
    corrections: sessionRows.reduce((n, s) => n + s.corrections, 0),
    sessionsCorrected: sessionRows.filter((s) => s.corrections > 0).length,
    abandoned: sessionRows.filter((s) => s.abandoned).length,
    timeToFirstEditSamples: sessionRows.filter((s) => s.timeToFirstEditMs != null).length,
    medianTimeToFirstEditMs: median(sessionRows.map((s) => s.timeToFirstEditMs)),
  };
  const modelRows = [...models.values()].map(({ rates: rateEntries, ...model }) => {
    const rates = rateEntries.map((entry) => entry.value);
    return {
      ...model,
      rate: rates.length === 1 ? rates[0] : null,
      rates,
      rateMode: rates.length > 1 ? 'mixed' : rates.length === 1 ? 'single' : 'unpriced',
    };
  });

  return {
    window: {
      from: windowFrom,
      to: windowTo,
      days: Number.isFinite(days) ? days : null,
      spanDays,
      mode: 'complete sessions whose latest valid activity is inside the window',
      seriesMode: Number.isFinite(days) ? 'calendar-days' : 'active-days',
      seriesTruncated: !Number.isFinite(days) && keys.length > maxAllSeriesDays,
      omittedActiveDays: !Number.isFinite(days) ? Math.max(0, keys.length - maxAllSeriesDays) : 0,
    },
    totals,
    perDay: series,
    punch,
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    models: modelRows.sort((a, b) => b.sessions - a.sessions),
    impact: { files: fileRows, directories: directoryRows, churnFiles: fileRows.filter((f) => f.sessions > 1 || f.churn > 1) },
    scoreboard: [...sources.values()].map(finalizeSource).sort((a, b) => b.sessions - a.sessions),
    providers: [...providers.values()]
      .map(finalizeProvider)
      .sort((a, b) => b.sessions - a.sessions || b.totalTokens - a.totalTokens),
    workflow,
    cost: {
      total: apiCost,
      pricedSessions,
      fullyPricedSessions,
      partiallyPricedSessions,
      unpricedSessions: sessions.length - fullyPricedSessions - partiallyPricedSessions,
      coverage: sessions.length ? fullyPricedSessions / sessions.length : 0,
      tokenCoverage: billableTokens ? pricedTokens / billableTokens : 0,
      pricedTokens,
      unpricedTokens: billableTokens - pricedTokens,
      isPartial: pricedTokens !== billableTokens,
      perSession: pricedSessions ? apiCost / pricedSessions : null,
      perEdit: pricedEdits ? apiCost / pricedEdits : null,
      bySource: [...sources.values()].map(finalizeSource).map((s) => ({ source: s.source, total: s.apiCost, sessions: s.sessions, pricedSessions: s.pricedSessions, costPerEdit: s.costPerEdit, costPer100Lines: s.costPer100Lines })),
      sessions: sessionRows.sort((a, b) => (b.apiCost || 0) - (a.apiCost || 0)),
      pricingUpdatedAt: pricing?.updatedAt ?? null,
      currency: pricing?.currency ?? 'USD',
    },
    records: {
      longestSession: longest,
      busiestDay: busiest && busiest.toolCalls ? busiest : null,
      peakHour: peak.n ? peak : null,
      activeDays,
      streak,
    },
  };
}

export function sessionSummary(session, pricing, includeEvents = false, analysis = null) {
  const intel = analysis ?? sessionIntelligence(session, pricing);
  return {
    key: session.key ?? `${session.source}:${session.id}`,
    id: session.id,
    source: session.source,
    agent: session.agent,
    label: session.label,
    model: session.model,
    provider: inferProvider(session.model, session.source, session.provider),
    runtime: session.runtime,
    startedAt: intel.startedMs == null ? null : new Date(intel.startedMs).toISOString(),
    endedAt: intel.endedMs == null ? null : new Date(intel.endedMs).toISOString(),
    parent: session.parent,
    children: session.children,
    stats: { ...session.stats, ...intel.observed },
    eventCount: intel.events.length,
    intelligence: {
      apiCost: intel.cost.total,
      rate: intel.cost.rate,
      rates: intel.cost.rates,
      pricingPartial: intel.cost.isPartial,
      pricedTokens: intel.cost.pricedTokens,
      billableTokens: intel.cost.billableTokens,
      edits: intel.editOperations,
      attemptedEdits: intel.attemptedEditOperations,
      failedEdits: intel.failedEditOperations,
      unconfirmedEdits: intel.unconfirmedEditOperations,
      additions: intel.additions,
      deletions: intel.deletions,
      changedLines: intel.changedLines,
      files: intel.files,
      reworkLoops: intel.reworkLoops,
      corrections: intel.corrections,
      abandoned: intel.abandoned,
      timeToFirstEditMs: intel.timeToFirstEditMs,
      medianToolLatencyMs: intel.medianToolLatencyMs,
      estimatedEdits: intel.estimatedOperations,
      futureEventsOmitted: intel.futureEventsOmitted,
    },
    ...(includeEvents ? { events: intel.events } : {}),
  };
}
