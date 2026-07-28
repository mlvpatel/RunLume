import path from 'node:path';

const MAX_ANALYTICS_PATH_LENGTH = 4096;

export const EDIT_TOOLS = new Set([
  'edit', 'write', 'notebookedit', 'multiedit', 'strreplace', 'str_replace_editor', 'apply_patch',
]);

const CORRECTION_RE = /(?:^|\b)(?:no[,—:]?|nope|wrong|incorrect|not what i|that(?:'s| is) not|you (?:missed|ignored|changed)|actually[,—:]?|instead[,—:]?|stop[,—:]?|undo|revert|go back|don(?:'t| not)|i said|please fix that)(?:\b|$)/i;

export const dayKey = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function tokenCount(value) {
  if (
    (typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !value.trim())
  ) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(number));
}

function tokenSum(...values) {
  return values.reduce(
    (sum, value) => Math.min(Number.MAX_SAFE_INTEGER, sum + tokenCount(value)),
    0,
  );
}

const PROVIDER_ALIASES = {
  openai: 'openai',
  'openai-api': 'openai',
  anthropic: 'anthropic',
  'anthropic-api': 'anthropic',
  claude: 'anthropic',
  google: 'google',
  gemini: 'google',
  nvidia: 'nvidia',
  nemotron: 'nvidia',
  moonshot: 'moonshot',
  kimi: 'moonshot',
  zhipu: 'zhipu',
  glm: 'zhipu',
  alibaba: 'alibaba',
  qwen: 'alibaba',
  meta: 'meta',
  llama: 'meta',
  mistral: 'mistral',
  deepseek: 'deepseek',
  cohere: 'cohere',
  xai: 'xai',
  grok: 'xai',
  local: 'local',
  ollama: 'local',
  lmstudio: 'local',
  'lm-studio': 'local',
};

/** Attribute a model event to a provider without conflating it with the agent source. */
export function inferProvider(model, source = null, explicitProvider = null) {
  const declared = String(explicitProvider ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (declared && PROVIDER_ALIASES[declared]) return PROVIDER_ALIASES[declared];

  const value = String(model ?? '').trim().toLowerCase();
  if (/(?:^|[/:\s-])(?:ollama|lmstudio|lm-studio|local)(?:$|[/:\s-])/.test(value)) return 'local';
  if (/(?:anthropic|claude)/.test(value)) return 'anthropic';
  if (/(?:openai|chatgpt|gpt|codex|(?:^|[/:\s-])o[1-9](?:$|[/:\s-]))/.test(value)) return 'openai';
  if (/(?:google|gemini|gemma)/.test(value)) return 'google';
  if (/(?:nvidia|nemotron)/.test(value)) return 'nvidia';
  if (/(?:moonshot|(?:^|[/:\s-])kimi(?:$|[/:\s-]))/.test(value)) return 'moonshot';
  if (/(?:zhipu|(?:^|[/:\s-])glm(?:$|[/:\s-]))/.test(value)) return 'zhipu';
  if (/(?:alibaba|(?:^|[/:\s-])qwen(?:$|[/:\s-]))/.test(value)) return 'alibaba';
  if (/(?:meta|llama)/.test(value)) return 'meta';
  if (/(?:^|[/:\s-])(?:mistral|mixtral)(?:$|[/:\s-])/.test(value)) return 'mistral';
  if (/(?:^|[/:\s-])deepseek(?:$|[/:\s-])/.test(value)) return 'deepseek';
  if (/(?:cohere|command-r)/.test(value)) return 'cohere';
  if (/(?:xai|(?:^|[/:\s-])grok(?:$|[/:\s-]))/.test(value)) return 'xai';

  if (source === 'claude-code') return 'anthropic';
  if (source === 'codex') return 'openai';
  if (source === 'gemini') return 'google';
  return 'unknown';
}

const lineCount = (value) => {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const normalized = value.replace(/\r\n/g, '\n');
  const count = normalized.split('\n').length;
  return normalized.endsWith('\n') ? count - 1 : count;
};

function canonicalProjectPath(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().replaceAll('\\', '/');
  if (!raw || raw.length > MAX_ANALYTICS_PATH_LENGTH) return null;

  const isUnc = raw.startsWith('//');
  const body = path.posix.normalize(isUnc ? raw.slice(2) : raw);
  let normalized = isUnc
    ? body === '.' ? '//' : `//${body.replace(/^\/+/, '')}`
    : body;
  if (/^[a-z]:/i.test(normalized)) {
    normalized = `${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  }
  if (normalized !== '/' && !/^[A-Z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized || null;
}

function isCaseInsensitiveProjectPath(value) {
  return typeof value === 'string' && (/^[A-Z]:\//i.test(value) || value.startsWith('//'));
}

function cleanFilePath(value, cwd = null) {
  if (typeof value !== 'string') return null;
  let out = value.trim().replace(/^['"]|['"]$/g, '').replaceAll('\\', '/');
  if (!out || out.length > MAX_ANALYTICS_PATH_LENGTH) return null;
  out = out.replace(/^[ab]\//, '');
  const normalizedCwd = canonicalProjectPath(cwd);
  const comparableOut = isCaseInsensitiveProjectPath(normalizedCwd) ? out.toLowerCase() : out;
  const comparableCwd = isCaseInsensitiveProjectPath(normalizedCwd) ? normalizedCwd.toLowerCase() : normalizedCwd;
  if (normalizedCwd && (comparableOut === comparableCwd || comparableOut.startsWith(`${comparableCwd}/`))) {
    out = out.slice(normalizedCwd.length).replace(/^\/+/, '') || '.';
  }
  out = path.posix.normalize(out).replace(/^\.\//, '');
  return out && out !== '/dev/null' ? out : null;
}

function sessionProject(session) {
  const cwd = canonicalProjectPath(session.cwd);
  if (cwd) return cwd;
  const file = canonicalProjectPath(session.file);
  if (file) return path.posix.dirname(file);
  return `${session.source}:${session.agent ?? 'unknown'}`;
}

function linesOf(value) {
  if (typeof value !== 'string' || !value) return [];
  const normalized = value.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

/**
 * Count the minimal line additions/removals for a replacement. Large blocks use
 * a bounded fallback after stripping common prefixes/suffixes.
 */
export function diffLineCounts(oldValue, newValue) {
  const oldLines = linesOf(oldValue);
  const newLines = linesOf(newValue);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const before = oldLines.slice(start, oldEnd);
  const after = newLines.slice(start, newEnd);
  if (!before.length || !after.length) {
    return { additions: after.length, deletions: before.length, estimated: false };
  }

  const cells = before.length * after.length;
  if (cells > 250_000) {
    return { additions: after.length, deletions: before.length, estimated: true };
  }
  const row = new Uint32Array(after.length + 1);
  for (let oldIndex = 1; oldIndex <= before.length; oldIndex++) {
    let diagonal = 0;
    for (let newIndex = 1; newIndex <= after.length; newIndex++) {
      const above = row[newIndex];
      row[newIndex] = before[oldIndex - 1] === after[newIndex - 1]
        ? diagonal + 1
        : Math.max(row[newIndex], row[newIndex - 1]);
      diagonal = above;
    }
  }
  const common = row[after.length];
  return {
    additions: after.length - common,
    deletions: before.length - common,
    estimated: false,
  };
}

function patchTextFrom(args) {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object') return '';
  for (const key of ['patch', 'input', 'cmd', 'command']) {
    if (typeof args[key] === 'string' && (args[key].includes('*** Begin Patch') || args[key].includes('diff --git '))) {
      let text = args[key];
      // Newer Codex wrappers can carry apply_patch inside a JavaScript string.
      if (!/^\*\*\* (?:Add|Update|Delete) File:/m.test(text)) text = decodeWrappedPatch(text);
      return text;
    }
  }
  return '';
}

function decodeWrappedPatch(source) {
  const marker = source.indexOf('*** Begin Patch');
  if (marker <= 0) return source;
  const quote = source[marker - 1];
  if (!['"', "'", '`'].includes(quote)) return source;
  let end = marker;
  while (end < source.length) {
    end = source.indexOf(quote, end + 1);
    if (end < 0) return source;
    let slashes = 0;
    for (let i = end - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 === 0) break;
  }
  const encoded = source.slice(marker, end);
  if (quote === '"') {
    try { return JSON.parse(`"${encoded}"`); } catch { /* use tolerant decoder */ }
  }
  let out = '';
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== '\\' || i === encoded.length - 1) { out += encoded[i]; continue; }
    const next = encoded[++i];
    out += next === 'n' ? '\n' : next === 'r' ? '\r' : next === 't' ? '\t' : next;
  }
  return out;
}

/** Parse Codex apply_patch and ordinary unified diff bodies into per-file deltas. */
export function parsePatch(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const records = new Map();
  let current = null;
  const get = (p, operation = 'update') => {
    p = cleanFilePath(p);
    if (!p) return null;
    if (!records.has(p)) records.set(p, {
      path: p,
      additions: 0,
      deletions: 0,
      ...(operation === 'delete' ? { estimated: true } : {}),
    });
    return records.get(p);
  };

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    let m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { current = get(m[2], m[1].toLowerCase()); continue; }
    m = /^\*\*\* Move to: (.+)$/.exec(line);
    if (m) {
      const targetPath = cleanFilePath(m[1]);
      if (current && targetPath) {
        records.delete(current.path);
        current.path = targetPath;
        records.set(targetPath, current);
      } else {
        current = get(m[1]);
      }
      continue;
    }
    m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) { current = get(m[2]); continue; }
    m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m && m[1] !== '/dev/null') { current = get(m[1]); continue; }
    if (!current || /^\+\+\+|^---/.test(line)) continue;
    if (line.startsWith('+')) current.additions++;
    else if (line.startsWith('-')) current.deletions++;
  }
  return [...records.values()].map((record) => {
    if (record.deletions > 0 && record.estimated) {
      const { estimated: _estimated, ...exact } = record;
      return exact;
    }
    return record;
  });
}

function stringEdit(pathValue, oldValue, newValue, cwd = null, writeMode = null) {
  const p = cleanFilePath(pathValue, cwd);
  if (!p) return [];
  if (writeMode) {
    return [{
      path: p,
      additions: lineCount(newValue),
      deletions: 0,
      ...(writeMode === 'unknown' ? { estimated: true } : {}),
    }];
  }
  const delta = diffLineCounts(oldValue, newValue);
  return [{
    path: p,
    additions: delta.additions,
    deletions: delta.deletions,
    ...(delta.estimated ? { estimated: true } : {}),
  }];
}

/** Normalize Edit/Write/NotebookEdit/str_replace_editor/apply_patch calls. */
export function extractEditOperations(ev, cwd = null) {
  if (ev?.kind !== 'tool') return [];
  const name = String(ev.tool?.name ?? '').toLowerCase();
  const args = ev.tool?.args ?? {};
  const patch = patchTextFrom(args);
  if (patch) {
    return parsePatch(patch).map((operation) => ({
      ...operation,
      path: cleanFilePath(operation.path, cwd),
    })).filter((operation) => operation.path);
  }
  if (!EDIT_TOOLS.has(name)) return [];

  const p = args.file_path ?? args.path ?? args.notebook_path ?? args.file;
  if (name === 'multiedit' || Array.isArray(args.edits)) {
    return (args.edits ?? []).flatMap((edit) => stringEdit(p, edit.old_string ?? edit.old_str ?? '', edit.new_string ?? edit.new_str ?? '', cwd));
  }
  if (name === 'write') return stringEdit(p, '', args.content ?? args.contents ?? args.file_text ?? args.text ?? '', cwd, 'unknown');
  if (name === 'notebookedit') return stringEdit(p, args.old_source ?? '', args.new_source ?? args.source ?? '', cwd);
  if (name === 'str_replace_editor') {
    const command = String(args.command ?? '').toLowerCase();
    if (command === 'create') return stringEdit(p, '', args.file_text ?? args.new_str ?? '', cwd, 'create');
    if (command === 'insert') return stringEdit(p, '', args.new_str ?? args.text ?? '', cwd, 'unknown');
    return stringEdit(p, args.old_str ?? args.old_string ?? '', args.new_str ?? args.new_string ?? '', cwd);
  }
  return stringEdit(p, args.old_string ?? args.old_str ?? '', args.new_string ?? args.new_str ?? args.content ?? '', cwd);
}

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
    if (!Number.isFinite(rate.input) || !Number.isFinite(rate.output)) {
      issues.push(`${prefix} requires numeric input and output rates`);
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
    + cacheRead * (rate.cacheRead ?? rate.input ?? 0)
    + cacheWriteUntiered * (rate.cacheWrite ?? rate.cacheWrite5m ?? rate.input ?? 0)
    + cacheWrite5m * (rate.cacheWrite5m ?? rate.cacheWrite ?? rate.input ?? 0)
    + cacheWrite1h * (rate.cacheWrite1h ?? rate.cacheWrite ?? rate.input ?? 0)
    + output * (rate.output || 0)
  ) / 1_000_000;
  return {
    ...entry,
    total,
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

export function priceSession(session, pricing) {
  const usageEntries = Array.isArray(session.usage) && session.usage.length
    ? session.usage
    : [{
      ts: session.startedAt,
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
  const pricedEntries = breakdown.filter((entry) => entry.total != null);
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

const median = (values) => {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

export function sessionIntelligence(session, pricing) {
  const files = new Map();
  const edits = [];
  const toolLatencies = [];
  const users = session.events.filter((e) => e.kind === 'user');
  let toolCalls = 0;
  let toolErrors = 0;
  let attemptedEditOperations = 0;
  let confirmedEditCalls = 0;
  let failedEditOperations = 0;
  let unconfirmedEditOperations = 0;
  let firstEditAt = null;

  for (const ev of session.events) {
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
  const last = [...session.events].reverse().find((e) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool');
  const isLive = session.endedAt && Date.now() - Date.parse(session.endedAt) < 5 * 60_000;
  const abandoned = Boolean(users.length && last?.kind !== 'assistant' && !isLive);
  const reworkLoops = [...files.values()].reduce((n, f) => n + Math.max(0, f.edits - 1), 0);
  const cost = priceSession(session, pricing);
  return {
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

export function buildStats(sessions, { days = 30, pricing = null, analysisByKey = null } = {}) {
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
    const intel = analysisByKey?.get(session.key) ?? sessionIntelligence(session, pricing);
    const source = sources.get(session.source) ?? sourceAggregate(session.source);
    sources.set(session.source, source);
    source.sessions++;
    source.edits += intel.editOperations;
    source.changedLines += intel.changedLines;
    source.outputTokens = tokenSum(source.outputTokens, session.stats.tokensOut);
    source.inputTokens = tokenSum(source.inputTokens, session.stats.tokensIn);
    source.cacheRead = tokenSum(source.cacheRead, session.stats.tokensCacheRead);
    source.toolCalls += intel.toolCalls;
    source.toolErrors += intel.toolErrors;
    source.toolLatencies.push(...intel.toolLatencies);
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
    totals.tokensIn = tokenSum(totals.tokensIn, session.stats.tokensIn);
    totals.tokensOut = tokenSum(totals.tokensOut, session.stats.tokensOut);
    totals.cacheRead = tokenSum(totals.cacheRead, session.stats.tokensCacheRead);
    totals.cacheWrite = tokenSum(totals.cacheWrite, session.stats.tokensCacheWrite);
    totals.errors += intel.toolErrors;
    totals.messages += session.stats.messages || 0;
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
        rate: pricedForModel[0]?.rate ?? null,
      };
      model.sessions++;
      if (pricedForModel.length) {
        model.apiCost += pricedForModel.reduce((sum, entry) => sum + entry.total, 0);
        model.pricedSessions++;
        model.rate ??= pricedForModel[0].rate;
      }
      models.set(modelKey, model);
    }

    const startedDay = day(dayKey(session.startedAt));
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
    if (session.startedAt && session.endedAt) {
      const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
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

    for (const ev of session.events) {
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
    const directory = path.posix.dirname(f.path.replaceAll('\\', '/'));
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
  const today = new Date();
  const series = [];
  const emptyDay = (date) => ({ date, toolCalls: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0, tokensCacheWrite: 0, sessions: 0, errors: 0, additions: 0, deletions: 0, edits: 0, apiCost: 0 });
  const maxAllSeriesDays = 730;
  if (Number.isFinite(days)) {
    const start = new Date(today.getTime() - (Math.max(1, days) - 1) * 86_400_000);
    for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); d <= today; d.setDate(d.getDate() + 1)) {
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

  return {
    window: {
      from: windowFrom,
      to: windowTo,
      days: Number.isFinite(days) ? days : null,
      spanDays,
      mode: 'complete sessions whose latest valid event is inside the window',
      seriesMode: Number.isFinite(days) ? 'calendar-days' : 'active-days',
      seriesTruncated: !Number.isFinite(days) && keys.length > maxAllSeriesDays,
      omittedActiveDays: !Number.isFinite(days) ? Math.max(0, keys.length - maxAllSeriesDays) : 0,
    },
    totals,
    perDay: series,
    punch,
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    models: [...models.values()].sort((a, b) => b.sessions - a.sessions),
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
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    parent: session.parent,
    children: session.children,
    stats: session.stats,
    eventCount: session.events.length,
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
    },
    ...(includeEvents ? { events: session.events } : {}),
  };
}
