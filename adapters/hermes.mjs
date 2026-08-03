import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  UUID_RE,
  newSession,
  isInjectedMetadataText,
  readJsonLines,
  readJsonDocument,
  parseGenericAgentFile,
  SPAWN_TOOL_RE,
  DEFAULT_MAX_TRANSCRIPT_BYTES,
  MAX_SESSION_ID_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  INJECTED_METADATA_TAGS,
  maxTranscriptBytes,
  tokenCount,
  tokenSum,
  boundedIdentifier,
  normalizedTimestamp,
  firstText,
  assignSessionModel,
  blocksOf,
  textOf,
  assignSessionId,
  normalizedUsage,
  recordUsage,
  appendUsage,
  readDiagnostics,
  openTranscript,
  nestedUuids,
  addToolCall,
  attachResult,
  touch,
  finalizeLabel,
  isLexicallyWithin,
  safeReaddir,
  safeChildPath,
  walkJsonl,
  walkJsonTranscripts,
  fileModifiedTimestamp,
  parseGenericMessage,
} from './shared.mjs';
import {
  parseClaudeCodeFile,
  CC_SKIP_TYPES,
  ccParseMessageInto,
  claudeCodeAdapter,
} from './claude.mjs';
import {
  parseCodexFile,
  codexOutput,
  codexAdapter,
} from './codex.mjs';
import {
  parseCursorFile,
  CURSOR_CLI_TOOL_NAMES,
  cursorCliTool,
  cursorToolResult,
  cursorNativeTool,
  cursorAdapter,
} from './cursor.mjs';
import {
  parseGeminiFile,
  GEMINI_TOOL_NAMES,
  geminiToolName,
  geminiContent,
  geminiTokens,
  geminiThoughtText,
  parseGeminiMessages,
  geminiAdapter,
} from './gemini.mjs';
import {
  parseApiLogFile,
  IMPORT_IDENTITY,
  importIdentity,
  firstImportId,
  assignImportedSessionId,
  importedTimestamp,
  importedText,
  importedArgs,
  addImportedUser,
  importedMessages,
  validateImportedRow,
  lastMessageIndex,
  addImportedRequest,
  importedOpenAiUsage,
  importedOpenAiResponse,
  importedAnthropicResponse,
  importedOllamaResponse,
  importedLmStudioResponse,
  apiLogAdapter,
} from './imports.mjs';
// ── Hermes (best-effort generic: HERMES_STATE_DIR or ~/.hermes) ──────────────
function hermesAdapter(maxBytes, explicitRoot = null) {
  const root = explicitRoot
    ? path.resolve(explicitRoot)
    : process.env.HERMES_STATE_DIR ?? path.join(os.homedir(), '.hermes');
  return {
    source: 'hermes',
    *findFiles() {
      for (const file of walkJsonl(root, 4)) {
        yield { file, agent: path.basename(path.dirname(file)), root };
      }
    },
    parseFile: ({ file, agent }) => parseGenericAgentFile('hermes', file, agent, maxBytes),
  };
}

export {
  hermesAdapter,
};
