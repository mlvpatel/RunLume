/**
 * Facade for the analytics pipeline, split by concern under analytics/:
 * shared primitives, line-diff impact, patch extraction, pricing,
 * per-session workflow intelligence, and cross-session statistics.
 */

export {
  diffLineCounts,
} from './analytics/impact.mjs';
export {
  extractEditOperations,
  parsePatch,
} from './analytics/patch.mjs';
export {
  priceSession,
  validatePricing,
} from './analytics/pricing.mjs';
export {
  EDIT_TOOLS,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  calendarWindowStart,
  dayKey,
  inferProvider,
} from './analytics/shared.mjs';
export {
  buildStats,
  sessionSummary,
} from './analytics/stats.mjs';
export {
  sessionIntelligence,
} from './analytics/workflow.mjs';

