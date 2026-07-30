# Reference

## Command line

```text
node server.mjs [options]

  --days <n>                activity window from 1 to 3650 days; default: 30
  --all                     include full discovered history
  --sources <list>          comma-separated sources, for example codex,cursor
  --import-dir <path>       read opt-in API and local-model JSONL logs
  --pricing <path>          use a custom per-model pricing JSON file
  --port <number>           localhost port; default: 4477
  --help                    show help
  --version                 show the installed version
```

`--all` and `--days` are mutually exclusive.

## Environment variables

| Variable | Purpose | Hard ceiling |
|---|---|---|
| `PORT` | Local server port | 65,535 |
| `RUNLUME_IMPORT_DIR` | Explicit API and local-model import root | File-system path |
| `RUNLUME_PRICING` | Custom pricing table | 2 MiB regular file |
| `CLAUDE_CONFIG_DIR` | Claude Code configuration root | File-system path |
| `CURSOR_STATE_DIR` | Cursor state root; default `~/.cursor` | File-system path |
| `CODEX_HOME` | Codex configuration root | File-system path |
| `GEMINI_STATE_DIR` | Gemini CLI state directory | File-system path |
| `GEMINI_CLI_HOME` | Home root containing Gemini CLI's `.gemini` directory | File-system path |
| `HERMES_STATE_DIR` | Hermes state root | File-system path |
| `RUNLUME_MAX_FILE_BYTES` | Maximum transcript size; default 64 MiB | 512 MiB |
| `RUNLUME_MAX_FILES` | Maximum discovered transcript files; default 10,000 | 100,000 |
| `RUNLUME_MAX_TOTAL_BYTES` | Maximum accepted transcript bytes; default 640 MiB | 8 GiB |
| `RUNLUME_MAX_EVENTS` | Maximum accepted events; default 1,000,000 | 2,000,000 |
| `RUNLUME_MAX_SESSIONS` | Maximum accepted sessions; default 10,000 | 50,000 |
| `RUNLUME_MIN_REFRESH_MS` | Minimum interval between transcript rescans; default 2,000 ms | 1 hour |

## API and local-model imports

Direct provider and local-model analysis is opt-in. Supported import identities
include OpenAI, Anthropic, NVIDIA/Nemotron, Moonshot/Kimi, Zhipu/GLM,
Alibaba/Qwen, Mistral, Ollama, and LM Studio. RunLume does not connect to an
account, inspect an API key, or make provider requests.

Point `--import-dir` at a directory of JSONL files. Each line is one captured
request and response:

```json
{
  "provider": "openai",
  "timestamp": "2026-07-20T10:00:00Z",
  "session_id": "synthetic-session",
  "request": {
    "model": "gpt-5.3-codex",
    "input": "Review this synthetic function"
  },
  "response": {
    "model": "gpt-5.3-codex",
    "output": [
      {
        "type": "message",
        "content": [
          {
            "type": "output_text",
            "text": "Add a guard."
          }
        ]
      }
    ],
    "usage": {
      "input_tokens": 120,
      "output_tokens": 30
    }
  }
}
```

Accepted provider values include `openai`, `anthropic`, `nvidia`, `nemotron`,
`moonshot`, `kimi`, `zhipu`, `glm`, `alibaba`, `qwen`, `mistral`, `ollama`,
`lm-studio`, `lmstudio`, and `local`. `request.body` and `response.body`
envelopes are accepted. Records sharing provider runtime and `session_id` form
one trajectory; otherwise the response ID or file name supplies a fallback
identity.

Files may be nested up to four directories under the import root. Headers and
credentials are ignored and never needed. Imported prompts and outputs remain
sensitive even though browser responses are redacted by default.

## Pricing

`pricing.json` stores USD rates per million tokens. A row contains a bounded
list of exact model identifiers, an optional source identifier, an optional
validated dated-suffix flag, and rates for input, output, cache read, and
optional cache-write durations. `effectiveFrom` and `effectiveTo` use
`YYYY-MM-DD`; the end date is exclusive. A source-scoped row cannot overlap a
global row or another row for the same source and model.

The table records its own `updatedAt` date. Check rate changes against the
[OpenAI model catalog](https://developers.openai.com/api/docs/models),
[Claude pricing documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
the [Claude Fable 5 and Mythos 5 announcement](https://www.anthropic.com/news/claude-fable-5-mythos-5),
and [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
before relying on a long-lived estimate.

At startup and after a pricing-file change, RunLume verifies:

- the path is a regular non-symbolic-link file no larger than 2 MiB;
- the JSON shape and numeric rates are valid;
- date ranges are valid and do not overlap for the same model;
- model identifiers use a restricted character set and are length-bounded;
- optional dated suffixes accept only `YYYYMMDD` or valid `YYYY-MM-DD` values.

For each usage event:

```text
cost =
  fresh input tokens × input rate
  + cache-read tokens × cache-read rate
  + cache-write tokens × applicable cache-write rate
  + output tokens × output rate
```

The result is divided by one million. Unknown models and events outside a
pricing row's effective dates remain unpriced. The UI reports both
fully-priced-session coverage and token-weighted coverage.
Every custom row must include a numeric `cacheRead` rate. Use `0` only when
cache-read tokens are not billable; an omitted value disables the invalid
pricing table instead of silently over- or under-billing usage.

API-equivalent cost is an estimate, not an invoice. It may exclude regional
multipliers, long-context tiers, hosted tools, modality tiers, negotiated
discounts, and provider-specific charges that the transcript does not expose.

Plan spend is optional and starts at zero. Names and monthly values are stored
only in browser local storage and scaled to the selected reporting window.

## Code impact

RunLume recognizes successful `Edit`, `Write`, `NotebookEdit`, `MultiEdit`,
`str_replace_editor`, and `apply_patch` payloads. Replacement operations use a
bounded minimal line diff after common prefixes and suffixes are removed. Large
blocks fall back to a visible estimate.

A whole-file write may not include the replaced content, so visible new lines
are counted as additions and marked estimated. A bare delete patch identifies
a file operation but contains no removed line count; the unknown line total
remains zero and is marked estimated.

Modern Codex patches nested in supported shell or JavaScript wrappers are
decoded only when the wrapper contains an explicit `apply_patch` invocation.
Patch-shaped preview text from other tools is ignored. Transcript code is never
executed.

## Workflow signals

| Signal | Calculation |
|---|---|
| Rework loop | Another successful edit to the same normalized project path in one session |
| Churn | Repeated successful touches to the same normalized project path across sessions |
| Abandoned | Non-live user-started trajectory ending without a final assistant event |
| Correction | Later user text matches the bounded correction phrase set |
| Time to first edit | First user timestamp to first successful parseable edit |
| Tool error rate | Confirmed failed tool results divided by confirmed tool calls |
| Cache efficiency | Cache-read tokens divided by total input tokens |

These are inspectable heuristics, not quality scores.

## Data windows and limits

The default scan includes sessions whose latest valid activity falls within
the current local calendar day and the preceding 29 local calendar days.
Complete qualifying sessions are analyzed. Sources without event time, such as
native Cursor transcripts, use file modification time for coarse activity and
daily attribution. Headline totals therefore describe a cohort of complete
sessions, while the daily chart includes only activity attributed to its
visible calendar dates. The chart is not intended to sum to the cohort totals.

For `--all`, aggregate totals include every accepted session while charts keep
the latest 730 active days. The API reports when earlier days were omitted.

The API pages trajectories at 100 events by default and allows at most 250 per
request. Tool and model identifiers are capped at 160 characters, analytics
paths at 4,096 characters, API strings at 100,000 characters, object properties
and ordinary arrays at 250 entries, and the browser session index at 10,000
rows. Aggregate tables send at most 250 rows per collection and report
total, shown, and omitted counts. Complete totals are calculated before those
presentation caps. API object nesting stops at eight levels.

Diagnostics expose every skipped file, malformed row, ambiguous relationship,
timestamp problem, reached scan budget, and browser-table omission.
