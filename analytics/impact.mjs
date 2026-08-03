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

const PATCH_WRAPPER_TOOLS = new Set(['bash', 'exec', 'exec_command', 'shell']);
const MAX_PATCH_WRAPPER_SOURCE_LENGTH = 4 * 1024 * 1024;
const MAX_PATCH_INVOCATIONS = 1_000;

function looksLikePatch(value) {
  return typeof value === 'string' && (
    value.includes('*** Begin Patch')
    || value.includes('diff --git ')
    || /^--- .+\r?\n\+\+\+ .+$/m.test(value)
  );
}

function directPatchText(args) {
  if (typeof args === 'string') {
    return args.length <= MAX_PATCH_WRAPPER_SOURCE_LENGTH && looksLikePatch(args) ? args : '';
  }
  if (!args || typeof args !== 'object') return '';
  for (const key of ['patch', 'input', 'cmd', 'command']) {
    if (
      typeof args[key] === 'string'
      && args[key].length <= MAX_PATCH_WRAPPER_SOURCE_LENGTH
      && looksLikePatch(args[key])
    ) return args[key];
  }
  return '';
}

function executableText(source) {
  let output = '';
  let mode = 'code';
  let lineComment = false;
  let blockComment = false;
  let regexCharacterClass = false;
  let previousSignificant = null;
  const templateExpressionDepths = [];
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === '\n') {
        lineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') {
        blockComment = false;
        output += '  ';
        index++;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (mode === 'single' || mode === 'double') {
      if (character === '\\') {
        output += ' ';
        if (index + 1 < source.length) {
          output += source[index + 1] === '\n' ? '\n' : ' ';
          index++;
        }
      } else if (
        (mode === 'single' && character === "'")
        || (mode === 'double' && character === '"')
      ) {
        mode = 'code';
        previousSignificant = 'value';
        output += ' ';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (mode === 'regex') {
      if (character === '\\') {
        output += ' ';
        if (index + 1 < source.length) {
          output += source[index + 1] === '\n' ? '\n' : ' ';
          index++;
        }
      } else if (character === '[') {
        regexCharacterClass = true;
        output += ' ';
      } else if (character === ']' && regexCharacterClass) {
        regexCharacterClass = false;
        output += ' ';
      } else if (character === '/' && !regexCharacterClass) {
        mode = 'code';
        previousSignificant = 'value';
        output += ' ';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (mode === 'template') {
      if (character === '\\') {
        output += ' ';
        if (index + 1 < source.length) {
          output += source[index + 1] === '\n' ? '\n' : ' ';
          index++;
        }
      } else if (character === '`') {
        mode = 'code';
        previousSignificant = 'value';
        output += ' ';
      } else if (character === '$' && next === '{') {
        templateExpressionDepths.push(1);
        mode = 'code';
        output += '  ';
        index++;
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      lineComment = true;
      output += '  ';
      index++;
    } else if (character === '/' && next === '*') {
      blockComment = true;
      output += '  ';
      index++;
    } else if (
      character === '/'
      && (
        previousSignificant == null
        || '=([{,:;!&|?+-*%^~<>'.includes(previousSignificant)
      )
    ) {
      mode = 'regex';
      regexCharacterClass = false;
      output += ' ';
    } else if (character === '#' && (index === 0 || /\s/.test(source[index - 1]))) {
      lineComment = true;
      output += ' ';
    } else if (character === '"') {
      mode = 'double';
      output += ' ';
    } else if (character === "'") {
      mode = 'single';
      output += ' ';
    } else if (character === '`') {
      mode = 'template';
      output += ' ';
    } else if (templateExpressionDepths.length && character === '{') {
      templateExpressionDepths[templateExpressionDepths.length - 1]++;
      output += character;
    } else if (templateExpressionDepths.length && character === '}') {
      const last = templateExpressionDepths.length - 1;
      templateExpressionDepths[last]--;
      if (templateExpressionDepths[last] === 0) {
        templateExpressionDepths.pop();
        mode = 'template';
        output += ' ';
      } else {
        output += character;
      }
    } else {
      output += character;
      if (!/\s/.test(character)) previousSignificant = character;
    }
  }
  return output;
}

function hasLocalApplyPatchDeclaration(source) {
  const code = executableText(source);
  return /^\s*(?:(?:export\s+)?(?:async\s+)?function|def)\s+apply_patch\s*\(/m.test(code)
    || /^\s*apply_patch\s*\([^)]*\)\s*(?:\{|:)/m.test(code)
    || /\b(?:const|let|var)\s+apply_patch\s*=/m.test(code)
    || /\bimport\s+[^;\n]*\bapply_patch\b/m.test(code);
}

function shellTokens(source) {
  const tokens = [];
  const operators = ['<<-', '<<', '&&', '||', ';', '|', '&', '\n'];
  let index = 0;
  while (index < source.length) {
    if (source[index] === ' ' || source[index] === '\t' || source[index] === '\r') {
      index++;
      continue;
    }
    if (source[index] === '#') {
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, index));
    if (operator) {
      tokens.push({ type: 'operator', value: operator, start: index, end: index + operator.length });
      index += operator.length;
      continue;
    }

    const start = index;
    let value = '';
    let quoted = false;
    while (index < source.length) {
      const character = source[index];
      if (/\s/.test(character) || operators.some((candidate) => source.startsWith(candidate, index))) break;
      if (character === "'" || character === '"' || character === '`') {
        quoted = true;
        const quote = character;
        index++;
        while (index < source.length && source[index] !== quote) {
          if (quote !== "'" && source[index] === '\\' && index + 1 < source.length) {
            index++;
            if (source[index] !== '\n') value += source[index];
            index++;
          } else {
            value += source[index++];
          }
        }
        if (source[index] === quote) index++;
        continue;
      }
      if (character === '\\' && index + 1 < source.length) {
        index++;
        if (source[index] !== '\n') value += source[index];
        index++;
        continue;
      }
      value += character;
      index++;
    }
    if (index === start) {
      index++;
      continue;
    }
    tokens.push({ type: 'word', value, quoted, start, end: index });
  }
  return tokens;
}

function heredocBody(source, start, delimiter, stripTabs) {
  let cursor = start;
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor);
    const end = newline < 0 ? source.length : newline;
    const line = source.slice(cursor, end);
    const candidate = stripTabs ? line.replace(/^\t+/, '') : line;
    if (candidate === delimiter) {
      return {
        body: source.slice(start, cursor),
        end: newline < 0 ? end : end + 1,
      };
    }
    if (newline < 0) break;
    cursor = newline + 1;
  }
  return null;
}

function shellCommandInfo(tokens) {
  let index = 0;
  while (tokens[index]?.type === 'word' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].value)) {
    index++;
  }
  let explicitCommand = false;
  if (tokens[index]?.type === 'word' && path.posix.basename(tokens[index].value) === 'command') {
    explicitCommand = true;
    index++;
  }
  const command = tokens[index]?.type === 'word'
    ? path.posix.basename(tokens[index].value)
    : null;
  return { command, commandIndex: index, explicitCommand };
}

function collectShellPatches(source, budget, depth = 0) {
  if (depth > 4 || source.length > MAX_PATCH_WRAPPER_SOURCE_LENGTH) return;
  const tokens = shellTokens(source);
  let commandTokens = [];
  let skipUntil = -1;
  let shadowed = false;

  const processCommand = (boundary) => {
    if (!commandTokens.length) return null;
    const info = shellCommandInfo(commandTokens);
    const nextCommand = commandTokens[info.commandIndex + 1]?.value ?? null;
    if (
      !info.explicitCommand
      && (
        info.command === 'apply_patch()'
        || (info.command === 'apply_patch' && nextCommand === '()')
        || (
          info.command === 'function'
          && (nextCommand === 'apply_patch' || nextCommand === 'apply_patch()')
        )
      )
    ) {
      shadowed = true;
    }

    if (['bash', 'sh', 'zsh'].includes(info.command)) {
      const optionIndex = commandTokens.findIndex((token, index) => (
        index > info.commandIndex
        && token.type === 'word'
        && /^-[A-Za-z]*c[A-Za-z]*$/.test(token.value)
      ));
      const script = optionIndex >= 0 ? commandTokens[optionIndex + 1] : null;
      if (script?.type === 'word') collectShellPatches(script.value, budget, depth + 1);
    }

    const heredocIndex = commandTokens.findIndex((token) => (
      token.type === 'operator' && (token.value === '<<' || token.value === '<<-')
    ));
    if (heredocIndex < 0 || boundary?.value !== '\n') return null;
    const delimiter = commandTokens[heredocIndex + 1];
    if (delimiter?.type !== 'word' || !delimiter.value) return null;
    const body = heredocBody(
      source,
      boundary.end,
      delimiter.value,
      commandTokens[heredocIndex].value === '<<-',
    );
    if (!body) return null;
    if (
      info.command === 'apply_patch'
      && (!shadowed || info.explicitCommand)
      && looksLikePatch(body.body)
    ) {
      budget.add(body.body);
    }
    return body.end;
  };

  for (const token of tokens) {
    if (token.start < skipUntil) continue;
    if (
      token.type === 'operator'
      && ['\n', ';', '&&', '||', '|', '&'].includes(token.value)
    ) {
      const nextSkip = processCommand(token);
      commandTokens = [];
      if (nextSkip != null) skipUntil = nextSkip;
    } else {
      commandTokens.push(token);
    }
  }
  processCommand(null);
}

function decodeStaticString(source, start, resolve, depth = 0) {
  const quote = source[start];
  if (!['"', "'", '`'].includes(quote) || depth > 16) return null;
  let output = '';
  for (let index = start + 1; index < source.length; index++) {
    const character = source[index];
    if (character === quote) return { value: output, end: index + 1 };
    if (quote === '`' && character === '$' && source[index + 1] === '{') {
      const expressionEnd = source.indexOf('}', index + 2);
      if (expressionEnd < 0) return null;
      const expression = source.slice(index + 2, expressionEnd).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(expression)) return null;
      const value = resolve(expression, start, depth + 1);
      if (value == null) return null;
      output += value;
      index = expressionEnd;
      continue;
    }
    if (character !== '\\' || index === source.length - 1) {
      output += character;
      continue;
    }
    const escaped = source[++index];
    if (escaped === '\n') continue;
    if (escaped === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
      output += String.fromCodePoint(Number.parseInt(source.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    if (escaped === 'u') {
      const braced = /^\{([0-9a-f]{1,6})\}/i.exec(source.slice(index + 1));
      if (braced) {
        const point = Number.parseInt(braced[1], 16);
        if (point > 0x10ffff) return null;
        output += String.fromCodePoint(point);
        index += braced[0].length;
        continue;
      }
      const digits = source.slice(index + 1, index + 5);
      if (/^[0-9a-f]{4}$/i.test(digits)) {
        output += String.fromCodePoint(Number.parseInt(digits, 16));
        index += 4;
        continue;
      }
    }
    output += {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0',
      '\\': '\\',
      '"': '"',
      "'": "'",
      '`': '`',
      '$': '$',
    }[escaped] ?? escaped;
  }
  return null;
}

function lexicalScopes(code) {
  const root = {
    start: 0,
    end: code.length,
    parent: null,
  };
  const scopes = [root];
  const stack = [root];
  for (let index = 0; index < code.length; index++) {
    if (code[index] === '{') {
      const scope = {
        start: index,
        end: code.length,
        parent: stack.at(-1),
      };
      scopes.push(scope);
      stack.push(scope);
    } else if (code[index] === '}' && stack.length > 1) {
      stack.pop().end = index + 1;
    }
  }
  return scopes;
}

function scopeAt(scopes, position) {
  let low = 0;
  let high = scopes.length - 1;
  let found = scopes[0];
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (scopes[middle].start <= position) {
      found = scopes[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  while (found.parent && position >= found.end) found = found.parent;
  return found;
}

function bindingEntryBefore(bindings, identifier, before) {
  const entries = bindings.get(identifier);
  if (!entries?.length) return null;
  let low = 0;
  let high = entries.length - 1;
  let foundIndex = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].at < before) {
      foundIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  for (let index = foundIndex; index >= 0; index--) {
    const entry = entries[index];
    if (entry.scope.start <= before && before < entry.scope.end) return entry;
  }
  return null;
}

function bindingBefore(bindings, identifier, before) {
  return bindingEntryBefore(bindings, identifier, before)?.value ?? null;
}

function staticAssignments(source, code) {
  const bindings = new Map();
  const scopes = lexicalScopes(code);
  const resolve = (identifier, before) => bindingBefore(bindings, identifier, before);
  const candidates = [];
  const declarationEquals = new Set();
  const declaration = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
  let match;
  while ((match = declaration.exec(code))) {
    const equalsAt = match.index + match[0].lastIndexOf('=');
    declarationEquals.add(equalsAt);
    candidates.push({
      at: match.index,
      identifier: match[1],
      start: equalsAt + 1,
      declaration: true,
    });
  }
  const assignment = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?!=|>)/g;
  while ((match = assignment.exec(code))) {
    const equalsAt = match.index + match[0].lastIndexOf('=');
    if (declarationEquals.has(equalsAt)) continue;
    let previous = match.index - 1;
    while (previous >= 0 && /[ \t\r]/.test(code[previous])) previous--;
    candidates.push({
      at: match.index,
      identifier: match[1],
      start: equalsAt + 1,
      declaration: false,
      statementBoundary: previous < 0 || [';', '\n', '{', '}'].includes(code[previous]),
    });
  }
  const compoundAssignment = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\|\|=|&&=|\?\?=|[+\-*/%&|^]=|\+\+|--)/g;
  while ((match = compoundAssignment.exec(code))) {
    candidates.push({
      at: match.index,
      identifier: match[1],
      start: match.index + match[0].length,
      declaration: false,
      statementBoundary: false,
    });
  }
  candidates.sort((left, right) => left.at - right.at);

  for (const candidate of candidates) {
    const currentScope = scopeAt(scopes, candidate.at);
    const prior = bindingEntryBefore(bindings, candidate.identifier, candidate.at);
    const ownerScope = candidate.declaration
      ? currentScope
      : prior?.scope ?? currentScope;
    const canResolve = candidate.declaration || (
      candidate.statementBoundary
      && (!prior || currentScope === prior.scope)
    );
    let start = candidate.start;
    while (/[ \t\r]/.test(source[start] ?? '')) start++;
    let value = null;
    let end = start;
    if (canResolve && ['"', "'", '`'].includes(source[start])) {
      const decoded = decodeStaticString(source, start, resolve);
      if (decoded) {
        value = decoded.value;
        end = decoded.end;
      }
    } else if (canResolve) {
      const alias = /^[A-Za-z_$][\w$]*/.exec(source.slice(start))?.[0];
      if (alias) {
        value = resolve(alias, start);
        end = start + alias.length;
      }
    }
    while (/[ \t\r]/.test(code[end] ?? '')) end++;
    if (![';', '\n', undefined].includes(code[end])) value = null;
    const entries = bindings.get(candidate.identifier) ?? [];
    entries.push({
      at: candidate.at,
      value,
      scope: ownerScope,
    });
    bindings.set(candidate.identifier, entries);
  }
  return bindings;
}

function staticInvocationArgument(source, code, openParen, bindings) {
  const resolve = (identifier, before) => bindingBefore(bindings, identifier, before);
  let start = openParen + 1;
  while (/\s/.test(source[start] ?? '')) start++;
  let value = null;
  let end = start;
  if (['"', "'", '`'].includes(source[start])) {
    const decoded = decodeStaticString(source, start, resolve);
    if (decoded) {
      value = decoded.value;
      end = decoded.end;
    }
  } else {
    const identifier = /^[A-Za-z_$][\w$]*/.exec(source.slice(start))?.[0];
    if (identifier) {
      value = resolve(identifier, start);
      end = start + identifier.length;
    }
  }
  while (/\s/.test(code[end] ?? '')) end++;
  return value != null && code[end] === ')' ? value : null;
}

function patchBudget() {
  const patches = [];
  let bytes = 0;
  return {
    patches,
    add(patch) {
      if (
        patches.length >= MAX_PATCH_INVOCATIONS
        || typeof patch !== 'string'
        || bytes + patch.length > MAX_PATCH_WRAPPER_SOURCE_LENGTH
      ) return false;
      patches.push(patch);
      bytes += patch.length;
      return true;
    },
  };
}

function collectJavaScriptPatches(source, budget) {
  const code = executableText(source);
  const bindings = staticAssignments(source, code);
  const shadowed = hasLocalApplyPatchDeclaration(source);
  const invocation = /(?<![\w$.])tools\.apply_patch\s*\(|(?<![\w$.])apply_patch\s*\(/g;
  let count = 0;
  let match;
  while ((match = invocation.exec(code))) {
    if (++count > MAX_PATCH_INVOCATIONS) break;
    const qualified = match[0].startsWith('tools.');
    if (!qualified && shadowed) continue;
    const openParen = code.indexOf('(', match.index);
    const patch = staticInvocationArgument(source, code, openParen, bindings);
    if (looksLikePatch(patch)) budget.add(patch);
  }
}

function wrappedPatchTexts(name, args) {
  if (!args || typeof args !== 'object') return [];
  const budget = patchBudget();
  for (const field of ['input', 'cmd', 'command']) {
    const source = args[field];
    if (typeof source !== 'string' || source.length > MAX_PATCH_WRAPPER_SOURCE_LENGTH) continue;
    if (name === 'exec' && field === 'input') collectJavaScriptPatches(source, budget);
    else collectShellPatches(source, budget);
  }
  return budget.patches;
}

/** Parse Codex apply_patch and ordinary unified diff bodies into per-file deltas. */
export {
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
};
