/**
 * Facade for the source adapters. Each agent CLI lives in its own module
 * under adapters/; this file re-exports the shared surface and assembles
 * the adapter list. See adapters/shared.mjs for the normalized model.
 */
import { maxTranscriptBytes } from './adapters/shared.mjs';
import { claudeCodeAdapter } from './adapters/claude.mjs';
import { codexAdapter } from './adapters/codex.mjs';
import { cursorAdapter } from './adapters/cursor.mjs';
import { geminiAdapter } from './adapters/gemini.mjs';
import { apiLogAdapter } from './adapters/imports.mjs';
import { hermesAdapter } from './adapters/hermes.mjs';
export * from './adapters/shared.mjs';
export * from './adapters/claude.mjs';
export * from './adapters/codex.mjs';
export * from './adapters/cursor.mjs';
export * from './adapters/gemini.mjs';
export * from './adapters/imports.mjs';
export * from './adapters/hermes.mjs';
export function makeAdapters({
  hermesDir = null,
  importDir = null,
  sources = null,
  maxFileBytes = maxTranscriptBytes(),
} = {}) {
  const maxBytes = Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0
    ? maxFileBytes
    : maxTranscriptBytes();
  const all = [
    claudeCodeAdapter(maxBytes),
    cursorAdapter(maxBytes),
    codexAdapter(maxBytes),
    geminiAdapter(maxBytes),
    ...(importDir ? [apiLogAdapter(importDir, maxBytes)] : []),
    hermesAdapter(maxBytes, hermesDir),
  ];
  return sources ? all.filter((a) => sources.includes(a.source)) : all;
}
