# Changelog

## 0.3.0 - 2026-07-29

- Added explicit provider attribution and opt-in import identities for NVIDIA
  Nemotron, Moonshot Kimi K3, Zhipu GLM 5.2, Alibaba Qwen 3.6, and Mistral.
  Unknown models remain visible and unpriced.
- Replaced custom executable pricing expressions with bounded declarative model
  aliases and validated date suffixes, removing the regular-expression
  injection and denial-of-service surface.
- Rebuilt the dashboard as a light operations workspace with a real above-the-
  fold token-flow chart, cost coverage, completion and reliability signals,
  compact KPI cards, and a recent-run stream. Recaptured the live localhost
  application with synthetic data for the screenshot, provider visual,
  narrated MP4, embedded English subtitle track, WebVTT, SRT, and transcript.
- Prepared the repository for public open-source use with a concise visual
  README, architecture and reference guides, issue forms, a pull request
  template, support and conduct guidance, and Dependabot updates.
- Moved the supported runtime baseline from end-of-life Node.js 18/20 to Node.js
  22+, added Node.js 24 and 26 CI coverage, pinned every GitHub Action to an
  immutable commit, disabled checkout credentials, and bounded job duration.
- Hardened Host and Origin parsing against user-info and malformed-host tricks,
  tightened the browser security policy and isolation headers, and bounded
  custom pricing files to regular non-symbolic-link files of at most 2 MiB.
- Removed assumed subscription prices. Plan comparison now starts at zero and
  appears only after the user enters a local plan name and cost.
- Expanded `.gitignore` to block accidental transcript, database, credential,
  signing-key, and editor-state commits while keeping synthetic fixtures
  explicitly allowed.
- Coerced and bounded provider token counters before aggregation so numeric
  strings, negative values, invalid values, and oversized totals cannot corrupt
  session statistics or hang charts.
- Unified the per-file transcript limit across CLI configuration, dashboard
  discovery, and every source adapter; strengthened the file-open check against
  symbolic-link replacement races and removed quadratic string copying for
  exceptionally long JSONL records.
- Preserved distinct, stable imported sessions when provider identifiers exceed
  the public ID limit, accepted pretty-printed legacy Gemini JSON, retained
  id-less completed tool results, and ignored out-of-range provider timestamps
  without aborting later records. Non-object JSON records are now diagnosed and
  skipped without discarding valid records that follow.
- Corrected finite-window labels to match the displayed calendar series, capped
  accidental multi-year calendar requests, and made browser storage and stalled
  API requests fail safely.
- Renamed the project, package, command, interface, environment variables, and
  public demo assets to RunLume.
- Added a narrated 30-second README dashboard tour with synchronized English
  WebVTT/SRT subtitles and a public transcript, all generated exclusively from
  the synthetic sample dataset. Removed an intentional orphan-result warning
  from the default demo output.
- Added an explicit, read-only `--import-dir` JSONL importer for captured
  OpenAI Responses or Chat Completions, Anthropic Messages, Ollama chat, and LM
  Studio native or compatible responses. No API key or account connector is
  required.
- Added model-provider attribution and a responsive provider comparison across
  agent sources, with visible unknowns, token and cache metrics, pricing
  coverage, an accessible data table, and a rule that local runtimes remain
  unpriced even when their model identifier resembles a hosted API model.
- Added first-class Gemini CLI discovery for saved chats and headless
  `stream-json`, including nested subagents, checkpoint updates, thoughts,
  official tool names, tool outcomes, errors, model usage, cache tokens,
  source filters, synthetic fixtures, and Standard text API pricing where a
  single unambiguous rate is available.
- Added first-class Cursor discovery, native IDE and CLI `stream-json` parsing,
  dynamic and built-in tool normalisation, failed-turn reporting, parsed
  `StrReplace`/`Write` impact, duplicate-session suppression, sub-agent
  relationships, source filters, synthetic fixtures, and documented native
  timestamp/token limitations.
- Raised the still-bounded aggregate scan budget from 512 MiB to 640 MiB so a
  newly enabled source does not displace otherwise valid local sessions on
  larger multi-agent histories.
- Corrected all-history diagnostics so sessions without timestamps are reported
  as included without daily attribution instead of incorrectly called excluded.
- Extended browser coverage to verify the light theme under dark system
  preferences, 375-pixel phone layouts, landscape layouts, and touch targets.
- Added a random per-launch Bearer token for every API route.
- Redacted transcript content and local identifiers by default, with an
  explicit raw-content reveal action.
- Replaced trajectory truncation with event pagination.
- Counted only confirmed successful edits and exposed failed or unfinished
  edit attempts separately.
- Isolated file-impact aggregation by project and collision-resistant session
  key.
- Validated transcript session IDs without aborting otherwise valid files.
- Made latest-activity calculation stack safe for large transcripts.
- Preserved HTML, XML, JSX, and comparison prompts that begin with `<`.
- Streamed JSONL ingestion in bounded chunks and hardened cache fingerprints
  against same-size replacements with restored modification times.
- Added file, aggregate-byte, event, session, and forced-refresh budgets with
  visible diagnostics.
- Rejected symbolic links and enforced real-path containment for transcripts,
  pricing, and static assets.
- Added per-turn model and date pricing, Claude 5-minute and 1-hour cache-write
  tiers, effective-date validation, and partial-session coverage.
- Attributed daily tokens, cost, and errors to their event timestamps and
  bounded all-history charts to the latest 730 active days.
- Reused session analysis across snapshot routes, calibrated source comparisons
  with sample counts, and marked whole-file write estimates explicitly.
- Paused polling in hidden tabs, retained mobile load errors, and throttled
  repeated manual refreshes.
- Added dedicated Hermes fixture and configured-root discovery tests.
- Added Chromium, Firefox, and WebKit dashboard E2E coverage for responsive
  layout, redaction, reveal, pagination, dialogs, data tables, and focus return.
- Added automated axe-core WCAG 2.0/2.1 A/AA audits and corrected theme
  contrast and keyboard access for scrollable regions.
- Added macOS and Windows unit jobs alongside the Linux Node.js matrix.
- Added a packed-artifact smoke test that installs and executes the published
  command, including symlink-safe CLI entry-point detection.

## 0.3.0 (2026-07-24)

- Hardened the localhost server against DNS rebinding and unsafe embedding.
- Added validated CLI options, graceful server errors, and bounded API output.
- Switched reporting windows from file modification time to session activity.
- Added collision-resistant public session keys and deterministic graph rebuilds.
- Added parser diagnostics, transcript size limits, and structured Codex errors.
- Replaced gross replacement-line counts with bounded minimal line diffs.
- Fixed rename/delete patch accounting and normalised paths relative to session roots.
- Tightened pricing patterns, added current model rows, and added token coverage.
- Consolidated frontend refreshes into one snapshot API with error handling.
- Added accessible data tables, modal focus management, and tablist keyboard support.
- Expanded analytics, adapter, server, security, cache, and windowing tests.
- Added CI, packaging allowlists, security guidance, and contribution guidance.

## 0.2.0 (2026-07-19)

- Initial cross-agent dashboard release.
