/**
 * Facade for the analytics pipeline, split by concern under analytics/:
 * shared primitives, line-diff impact, patch extraction, pricing,
 * per-session workflow intelligence, and cross-session statistics.
 */
export * from './analytics/shared.mjs';
export * from './analytics/impact.mjs';
export * from './analytics/patch.mjs';
export * from './analytics/pricing.mjs';
export * from './analytics/workflow.mjs';
export * from './analytics/stats.mjs';
