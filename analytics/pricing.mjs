import {
  inferProvider,
  timestampIsAfter,
  tokenCount,
  tokenSum,
} from './shared.mjs';

function validIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function effectiveInterval(rate, pricing) {
  const from = rate.effectiveFrom ?? pricing.effectiveFrom;
  const to = rate.effectiveTo ?? pricing.effectiveTo;
  if ((from && !validIsoDay(from)) || (to && !validIsoDay(to))) return null;
  return {
    from: from ? Date.parse(`${from}T00:00:00Z`) : Number.NEGATIVE_INFINITY,
    to: to ? Date.parse(`${to}T00:00:00Z`) : Number.POSITIVE_INFINITY,
  };
}

function findIntervalOverlap(intervals) {
  const ordered = [...intervals].sort((a, b) => a.from - b.from || b.to - a.to);
  let active = null;
  for (const current of ordered) {
    if (active && current.index !== active.index && current.from < active.to) {
      return [active, current];
    }
    if (!active || current.to > active.to) active = current;
  }
  return null;
}

function pricingOverlapIssues(intervals) {
  const byAlias = new Map();
  for (const interval of intervals) {
    const group = byAlias.get(interval.alias) ?? [];
    group.push(interval);
    byAlias.set(interval.alias, group);
  }

  const candidateGroups = new Map(byAlias);
  for (const [alias, group] of byAlias) {
    const dated = /^(.*)-(?:\d{8}|\d{4}-\d{2}-\d{2})$/.exec(alias);
    if (!dated) continue;
    const suffixDate = alias.slice(dated[1].length + 1);
    if (!(/^\d{8}$/.test(suffixDate) || validIsoDay(suffixDate))) continue;
    const datedBaseRows = (byAlias.get(dated[1]) ?? []).filter((row) => row.allowDatedSuffix);
    if (datedBaseRows.length) candidateGroups.set(alias, [...group, ...datedBaseRows]);
  }

  const issues = [];
  const reported = new Set();
  for (const [alias, group] of candidateGroups) {
    const globals = group.filter((row) => !row.source);
    const scopes = new Set(group.map((row) => row.source).filter(Boolean));
    const scopedGroups = scopes.size
      ? [...scopes].map((source) => [...globals, ...group.filter((row) => row.source === source)])
      : [globals];
    for (const scoped of scopedGroups) {
      const overlap = findIntervalOverlap(scoped);
      if (!overlap) continue;
      const [left, right] = overlap;
      const pair = [left.index, right.index].sort((a, b) => a - b);
      const key = `${pair[0]}:${pair[1]}:${alias}`;
      if (reported.has(key)) continue;
      reported.add(key);
      issues.push(`models[${pair[0]}] overlaps models[${pair[1]}] for model ${alias}`);
    }
  }
  return issues;
}

export function validatePricing(pricing) {
  const issues = [];
  const intervals = [];
  if (!pricing || typeof pricing !== 'object') return ['pricing must be an object'];
  if (!Array.isArray(pricing.models) || !pricing.models.length) issues.push('models must be a non-empty array');
  if (typeof pricing.currency !== 'string' || !/^[A-Z]{3}$/.test(pricing.currency)) issues.push('currency must be a three-letter uppercase code');
  for (const field of ['effectiveFrom', 'effectiveTo']) {
    if (pricing[field] != null && !validIsoDay(pricing[field])) {
      issues.push(`${field} must be a valid YYYY-MM-DD date`);
    }
  }
  const ids = new Set();
  for (const [index, rate] of (pricing.models ?? []).entries()) {
    const prefix = `models[${index}]`;
    if (!rate || typeof rate !== 'object') {
      issues.push(`${prefix} must be an object`);
      continue;
    }
    if (typeof rate.id !== 'string' || !rate.id) issues.push(`${prefix}.id is required`);
    else if (ids.has(rate.id)) issues.push(`${prefix}.id duplicates ${rate.id}`);
    else ids.add(rate.id);
    if (
      rate.source != null
      && (
        typeof rate.source !== 'string'
        || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(rate.source)
      )
    ) {
      issues.push(`${prefix}.source is not a valid source identifier`);
    }
    const validAliases = [];
    if (!Array.isArray(rate.models) || !rate.models.length) {
      issues.push(`${prefix}.models must be a non-empty array`);
    } else {
      const aliases = new Set();
      for (const [modelIndex, model] of rate.models.entries()) {
        if (
          typeof model !== 'string'
          || !model
          || model.length > 160
          || !/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)
        ) {
          issues.push(`${prefix}.models[${modelIndex}] is not a valid model identifier`);
          continue;
        }
        const normalized = model.toLowerCase();
        if (aliases.has(normalized)) issues.push(`${prefix}.models duplicates ${model}`);
        else {
          aliases.add(normalized);
          validAliases.push(normalized);
        }
      }
    }
    if (rate.allowDatedSuffix != null && typeof rate.allowDatedSuffix !== 'boolean') {
      issues.push(`${prefix}.allowDatedSuffix must be a boolean`);
    }
    for (const field of ['effectiveFrom', 'effectiveTo']) {
      if (rate[field] != null && !validIsoDay(rate[field])) {
        issues.push(`${prefix}.${field} must be a valid YYYY-MM-DD date`);
      }
    }
    const effectiveFrom = rate.effectiveFrom ?? pricing.effectiveFrom;
    const effectiveTo = rate.effectiveTo ?? pricing.effectiveTo;
    if (effectiveFrom && effectiveTo && Date.parse(effectiveFrom) >= Date.parse(effectiveTo)) {
      issues.push(`${prefix} effective date range is empty or reversed`);
    }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h']) {
      if (rate[field] != null && (!Number.isFinite(rate[field]) || rate[field] < 0)) {
        issues.push(`${prefix}.${field} must be a non-negative number`);
      }
    }
    if (
      !Number.isFinite(rate.input)
      || !Number.isFinite(rate.output)
      || !Number.isFinite(rate.cacheRead)
    ) {
      issues.push(`${prefix} requires numeric input, output, and cacheRead rates`);
    }
    const interval = effectiveInterval(rate, pricing);
    if (interval && interval.from < interval.to && (rate.source == null || typeof rate.source === 'string')) {
      for (const alias of validAliases) {
        intervals.push({
          ...interval,
          alias,
          allowDatedSuffix: rate.allowDatedSuffix === true,
          index,
          source: rate.source ?? null,
        });
      }
    }
  }
  issues.push(...pricingOverlapIssues(intervals));
  return issues;
}

function modelMatchesRate(value, rate) {
  const normalized = value.toLowerCase();
  for (const alias of rate.models) {
    const candidate = alias.toLowerCase();
    if (normalized === candidate) return true;
    if (!rate.allowDatedSuffix || !normalized.startsWith(`${candidate}-`)) continue;
    const suffix = normalized.slice(candidate.length + 1);
    if (/^\d{8}$/.test(suffix) || validIsoDay(suffix)) return true;
  }
  return false;
}

function rateFor(model, source, pricing, ts) {
  if (!pricing?.models?.length) return null;
  const value = String(model ?? '');
  if (!value || value.length > 160) return null;
  for (const rate of pricing.models) {
    if (rate.source && rate.source !== source) continue;
    const effectiveFrom = rate.effectiveFrom ?? pricing.effectiveFrom;
    const effectiveTo = rate.effectiveTo ?? pricing.effectiveTo;
    if (effectiveFrom || effectiveTo) {
      const when = Date.parse(ts);
      if (!Number.isFinite(when)) continue;
      if (effectiveFrom && when < Date.parse(`${effectiveFrom}T00:00:00Z`)) continue;
      if (effectiveTo && when >= Date.parse(`${effectiveTo}T00:00:00Z`)) continue;
    }
    if (modelMatchesRate(value, rate)) return rate;
  }
  return null;
}

function publicRate(rate, pricing) {
  return {
    id: rate.id,
    label: rate.label,
    input: rate.input,
    output: rate.output,
    cacheRead: rate.cacheRead,
    cacheWrite: rate.cacheWrite,
    cacheWrite5m: rate.cacheWrite5m,
    cacheWrite1h: rate.cacheWrite1h,
    effectiveFrom: rate.effectiveFrom ?? pricing?.effectiveFrom,
    effectiveTo: rate.effectiveTo ?? pricing?.effectiveTo,
  };
}

function priceUsageEntry(entry, source, pricing, explicitProvider = null) {
  const input = tokenCount(entry.input);
  const output = tokenCount(entry.output);
  const cacheRead = Math.min(input, tokenCount(entry.cacheRead));
  const cacheWrite = Math.min(
    Math.max(0, input - cacheRead),
    tokenCount(entry.cacheWrite),
  );
  const cacheWrite5m = Math.min(cacheWrite, tokenCount(entry.cacheWrite5m));
  const cacheWrite1h = Math.min(
    Math.max(0, cacheWrite - cacheWrite5m),
    tokenCount(entry.cacheWrite1h),
  );
  const cacheWriteUntiered = Math.max(0, cacheWrite - cacheWrite5m - cacheWrite1h);
  const freshInput = Math.max(0, input - cacheRead - cacheWrite);
  const billableTokens = tokenSum(input, output);
  const rate = explicitProvider === 'local'
    ? null
    : rateFor(entry.model, source, pricing, entry.ts);
  if (!rate) {
    return {
      ...entry,
      total: null,
      rate: null,
      billableTokens,
      freshInput,
      cacheRead,
      cacheWrite,
      cacheWrite5m,
      cacheWrite1h,
      output,
    };
  }
  const total = (
    freshInput * (rate.input || 0)
    + cacheRead * (rate.cacheRead ?? 0)
    + cacheWriteUntiered * (rate.cacheWrite ?? rate.cacheWrite5m ?? rate.input ?? 0)
    + cacheWrite5m * (rate.cacheWrite5m ?? rate.cacheWrite ?? rate.input ?? 0)
    + cacheWrite1h * (rate.cacheWrite1h ?? rate.cacheWrite ?? rate.input ?? 0)
    + output * (rate.output || 0)
  ) / 1_000_000;
  return {
    ...entry,
    total: Number.isFinite(total) ? total : null,
    rate: publicRate(rate, pricing),
    billableTokens,
    freshInput,
    cacheRead,
    cacheWrite,
    cacheWrite5m,
    cacheWrite1h,
    output,
  };
}

export function priceSession(session, pricing, {
  maximumTimestamp = Infinity,
  fallbackTimestamp = session.startedAt,
} = {}) {
  const hasUsageEntries = Array.isArray(session.usage) && session.usage.length;
  const usageEntries = hasUsageEntries
    ? session.usage.filter((entry) => !timestampIsAfter(entry?.ts, maximumTimestamp))
    : [{
      ts: timestampIsAfter(fallbackTimestamp, maximumTimestamp) ? null : fallbackTimestamp,
      model: session.model,
      input: session.stats?.tokensIn ?? 0,
      output: session.stats?.tokensOut ?? 0,
      cacheRead: session.stats?.tokensCacheRead ?? 0,
      cacheWrite: session.stats?.tokensCacheWrite ?? 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    }];
  const breakdown = usageEntries.map((entry) => priceUsageEntry(
    entry,
    session.source,
    pricing,
    inferProvider(null, session.source, session.provider),
  ));
  const pricedEntries = breakdown.filter((entry) => Number.isFinite(entry.total));
  const rates = [...new Map(pricedEntries.map((entry) => [entry.rate.id, entry.rate])).values()];
  const billableTokens = breakdown.reduce((sum, entry) => tokenSum(sum, entry.billableTokens), 0);
  const pricedTokens = pricedEntries.reduce((sum, entry) => tokenSum(sum, entry.billableTokens), 0);
  return {
    total: pricedEntries.length ? pricedEntries.reduce((sum, entry) => sum + entry.total, 0) : null,
    rate: rates.length === 1 ? rates[0] : null,
    rates,
    isPartial: pricedEntries.length !== breakdown.length,
    billableTokens,
    pricedTokens,
    unpricedTokens: billableTokens - pricedTokens,
    freshInput: breakdown.reduce((sum, entry) => tokenSum(sum, entry.freshInput), 0),
    cacheRead: breakdown.reduce((sum, entry) => tokenSum(sum, entry.cacheRead), 0),
    cacheWrite: breakdown.reduce((sum, entry) => tokenSum(sum, entry.cacheWrite), 0),
    output: breakdown.reduce((sum, entry) => tokenSum(sum, entry.output), 0),
    breakdown,
  };
}

