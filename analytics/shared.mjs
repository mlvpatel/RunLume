import path from 'node:path';

const MAX_ANALYTICS_PATH_LENGTH = 4096;
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60_000;
const GIT_PATCH_PATH = Symbol('gitPatchPath');

export const EDIT_TOOLS = new Set([
  'edit', 'write', 'notebookedit', 'multiedit', 'strreplace', 'str_replace_editor', 'apply_patch',
]);

const CORRECTION_RE = /(?:^|\b)(?:no[,—:]?|nope|wrong|incorrect|not what i|that(?:'s| is) not|you (?:missed|ignored|changed)|actually[,—:]?|instead[,—:]?|stop[,—:]?|undo|revert|go back|don(?:'t| not)|i said|please fix that)(?:\b|$)/i;

export const dayKey = (ts) => {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function analyticsTimestampMs(value) {
  if (typeof value !== 'string' || !value || value.length > 128) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampIsAfter(value, maximum) {
  const parsed = analyticsTimestampMs(value);
  return parsed != null && parsed > maximum;
}

export function calendarWindowStart(now, days) {
  const start = new Date(now);
  if (Number.isNaN(start.getTime())) throw new Error('window start requires a valid date');
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('window days must be a positive integer');
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

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

function cleanFilePath(value, cwd = null, { preserveBackslashes = false } = {}) {
  if (typeof value !== 'string') return null;
  let out = value.trim().replace(/^['"]|['"]$/g, '');
  if (!preserveBackslashes) out = out.replaceAll('\\', '/');
  if (!out || out.length > MAX_ANALYTICS_PATH_LENGTH) return null;
  const normalizedCwd = canonicalProjectPath(cwd);
  const comparableOut = isCaseInsensitiveProjectPath(normalizedCwd) ? out.toLowerCase() : out;
  const comparableCwd = isCaseInsensitiveProjectPath(normalizedCwd) ? normalizedCwd.toLowerCase() : normalizedCwd;
  if (normalizedCwd && (comparableOut === comparableCwd || comparableOut.startsWith(`${comparableCwd}/`))) {
    out = out.slice(normalizedCwd.length).replace(/^\/+/, '') || '.';
  }
  out = path.posix.normalize(out).replace(/^\.\//, '');
  return out && out !== '/dev/null' ? out : null;
}

function decodeGitQuotedPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let output = '';
  const octets = [];
  const flushOctets = () => {
    if (!octets.length) return;
    output += Buffer.from(octets).toString('utf8');
    octets.length = 0;
  };
  for (let index = 1; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (character === '"') {
      flushOctets();
      return output;
    }
    if (character !== '\\' || index === trimmed.length - 1) {
      flushOctets();
      output += character;
      continue;
    }
    const escaped = trimmed[++index];
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(trimmed[index + 1] ?? '')) {
        octal += trimmed[++index];
      }
      octets.push(Number.parseInt(octal, 8));
      continue;
    }
    flushOctets();
    output += {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '"': '"',
      '\\': '\\',
    }[escaped] ?? escaped;
  }
  return null;
}

function patchHeaderPath(value, gitPrefix = null) {
  if (typeof value !== 'string') return null;
  const token = value.trimStart().startsWith('"')
    ? value.trimStart()
    : value.split('\t', 1)[0];
  let decoded = decodeGitQuotedPath(token);
  if (decoded == null) return null;
  if (gitPrefix && decoded.startsWith(gitPrefix)) decoded = decoded.slice(gitPrefix.length);
  return decoded;
}

function gitDiffPaths(line) {
  const source = line.slice('diff --git '.length);
  if (source.startsWith('"')) {
    let escaped = false;
    let end = -1;
    for (let index = 1; index < source.length; index++) {
      if (!escaped && source[index] === '"') {
        end = index;
        break;
      }
      escaped = !escaped && source[index] === '\\';
      if (source[index] !== '\\') escaped = false;
    }
    if (end < 0) return null;
    const first = source.slice(0, end + 1);
    const second = source.slice(end + 1).trimStart();
    const oldPath = patchHeaderPath(first, 'a/');
    const newPath = patchHeaderPath(second, 'b/');
    return oldPath && newPath ? [oldPath, newPath] : null;
  }
  if (!source.startsWith('a/')) return null;
  const separators = [];
  for (let index = source.indexOf(' b/'); index >= 0; index = source.indexOf(' b/', index + 1)) {
    separators.push(index);
  }
  const samePathSeparator = separators.find((index) => (
    source.slice(2, index) === source.slice(index + 3)
  ));
  if (samePathSeparator == null) return null;
  return [
    source.slice(2, samePathSeparator),
    source.slice(samePathSeparator + 3),
  ];
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
 * Compute the median of a list of numeric values. Returns null for empty input.
 */
const median = (values) => {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
};

export {
  median,
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
};
