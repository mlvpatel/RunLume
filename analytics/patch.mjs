import path from 'node:path';
import {
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
export function parsePatch(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const records = new Map();
  let current = null;
  let customFile = false;
  let inHunk = false;
  let oldLinesRemaining = null;
  let newLinesRemaining = null;
  let pendingOldPath = null;
  let pendingDiffPaths = null;
  let pendingDiffDelete = false;
  const get = (p, operation = 'update', gitPath = false) => {
    p = cleanFilePath(p, null, { preserveBackslashes: gitPath });
    if (!p) return null;
    if (!records.has(p)) records.set(p, {
      path: p,
      additions: 0,
      deletions: 0,
      ...(operation === 'delete' ? { estimated: true } : {}),
    });
    const record = records.get(p);
    if (gitPath && !record[GIT_PATCH_PATH]) {
      Object.defineProperty(record, GIT_PATCH_PATH, { value: true });
    }
    if (operation === 'delete') record.estimated = true;
    return record;
  };

  for (const line of patch.replace(/\r\n/g, '\n').split('\n')) {
    let m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) {
      current = get(m[2], m[1].toLowerCase());
      customFile = true;
      inHunk = false;
      oldLinesRemaining = null;
      newLinesRemaining = null;
      pendingOldPath = null;
      pendingDiffPaths = null;
      pendingDiffDelete = false;
      continue;
    }
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
    const diffPaths = line.startsWith('diff --git ') ? gitDiffPaths(line) : null;
    if (line.startsWith('diff --git ')) {
      pendingDiffPaths = diffPaths;
      pendingDiffDelete = false;
      current = null;
      customFile = false;
      inHunk = false;
      oldLinesRemaining = null;
      newLinesRemaining = null;
      pendingOldPath = null;
      continue;
    }
    if (!inHunk && /^deleted file mode \d+$/.test(line)) {
      pendingDiffDelete = true;
      if (!current && pendingDiffPaths) current = get(pendingDiffPaths[0], 'delete', true);
      if (current) current.estimated = true;
      continue;
    }
    m = /^rename from (.+)$/.exec(line);
    if (!inHunk && m) {
      pendingOldPath = patchHeaderPath(m[1]);
      continue;
    }
    m = /^rename to (.+)$/.exec(line);
    if (!inHunk && m) {
      current = get(patchHeaderPath(m[1]), 'update', true);
      pendingOldPath = null;
      pendingDiffPaths = null;
      continue;
    }
    m = /^Binary files (.+) and \/dev\/null differ$/.exec(line);
    if (!inHunk && m) {
      current ??= get(patchHeaderPath(m[1], 'a/'), 'delete', true);
      if (current) current.estimated = true;
      continue;
    }
    if (!inHunk && (line === 'GIT binary patch' || /^Binary files .+ differ$/.test(line))) {
      current ??= pendingDiffPaths
        ? get(
          pendingDiffDelete ? pendingDiffPaths[0] : pendingDiffPaths[1],
          pendingDiffDelete ? 'delete' : 'update',
          true,
        )
        : null;
      if (current) current.estimated = true;
      continue;
    }
    if (!inHunk) {
      m = /^--- (.+)$/.exec(line);
      if (m) {
        pendingOldPath = patchHeaderPath(m[1], 'a/');
        continue;
      }
      m = /^\+\+\+ (.+)$/.exec(line);
      if (m && pendingOldPath != null) {
        const nextPath = patchHeaderPath(m[1], 'b/');
        current = nextPath === '/dev/null'
          ? get(pendingOldPath, 'delete', true)
          : get(nextPath, 'update', true);
        pendingOldPath = null;
        pendingDiffPaths = null;
        continue;
      }
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk || /^@@(?:\s|$)/.test(line)) {
      inHunk = true;
      oldLinesRemaining = hunk ? Number(hunk[1] ?? 1) : null;
      newLinesRemaining = hunk ? Number(hunk[2] ?? 1) : null;
      pendingOldPath = null;
      continue;
    }
    if (!current || (!customFile && !inHunk)) continue;
    if (line.startsWith('+')) {
      current.additions++;
      if (newLinesRemaining != null) newLinesRemaining--;
    } else if (line.startsWith('-')) {
      current.deletions++;
      if (oldLinesRemaining != null) oldLinesRemaining--;
    } else if (line.startsWith(' ')) {
      if (oldLinesRemaining != null) oldLinesRemaining--;
      if (newLinesRemaining != null) newLinesRemaining--;
    }
    if (
      !customFile
      && oldLinesRemaining != null
      && newLinesRemaining != null
      && oldLinesRemaining <= 0
      && newLinesRemaining <= 0
    ) {
      inHunk = false;
      oldLinesRemaining = null;
      newLinesRemaining = null;
    }
  }
  return [...records.values()].map((record) => {
    if (record.deletions > 0 && record.estimated) {
      const { estimated: _estimated, ...exact } = record;
      if (record[GIT_PATCH_PATH]) Object.defineProperty(exact, GIT_PATCH_PATH, { value: true });
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
  const patches = name === 'apply_patch'
    ? [directPatchText(args)].filter(Boolean)
    : PATCH_WRAPPER_TOOLS.has(name)
      ? wrappedPatchTexts(name, args)
      : [];
  if (patches.length) {
    return patches.flatMap((patch) => (
      parsePatch(patch).map((operation) => ({
        ...operation,
        path: cleanFilePath(operation.path, cwd, {
          preserveBackslashes: operation[GIT_PATCH_PATH] === true,
        }),
      })).filter((operation) => operation.path)
    ));
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

export {
  stringEdit,
  validIsoDay,
  effectiveInterval,
  findIntervalOverlap,
  pricingOverlapIssues,
};
