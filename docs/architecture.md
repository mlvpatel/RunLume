# Architecture

RunLume is a read-only local analysis pipeline. Its security boundary is the
single user's machine and the loopback interface.

![RunLume data flow and trust boundary](./architecture.svg)

## Data flow

### 1. Discovery

`adapters.mjs` resolves supported state roots and finds transcript files.
Discovery is source-specific, read-only, depth-limited where applicable, and
bounded by file count and aggregate bytes. Symbolic links are rejected.

An API or local-model capture is never discovered automatically. The user must
provide `--import-dir` or `RUNLUME_IMPORT_DIR`.

### 2. Normalization

Each adapter maps its source format into the same model:

```text
session
├── identity: source, key, project, parent, children
├── time: startedAt, endedAt
├── model: model, provider, runtime
├── usage: input, output, cache read, cache write
└── events
    ├── user / assistant / thinking / metadata
    └── tool call + result + outcome + duration
```

Malformed records are skipped and counted. IDs, model and tool names, counters,
timestamps, analytics paths, files, events, and sessions are bounded before
analysis.

### 3. Analysis

`analytics.mjs` runs deterministic calculations over normalized sessions:

- dated model pricing with visible coverage;
- successful edit extraction and bounded line diffs;
- project-aware file churn and rework;
- corrections, abandonment, errors, latency, and time to first edit;
- agent-source and model-provider comparison;
- per-day series, session records, and sub-agent relationships.

No model executes during analysis. RunLume parses tool payloads as data and
never runs transcript commands or patches.

### 4. API boundary

`server.mjs` creates one random capability per launch and binds to `127.0.0.1`.
A direct document navigation receives a browser-specific capability in an
`HttpOnly`, `SameSite=Strict` session cookie. It is derived from the raw API
token with HMAC, so the raw token is never stored in the cookie, read by
JavaScript, or logged. Every `/api/` request requires that cookie or an explicit
Bearer token. Host and Origin validation rejects non-loopback names, user-info
tricks, malformed hosts, wrong ports, and non-HTTP origins.

Dashboard responses contain hashed public session keys, generic labels, and
redacted content. Raw trajectory data is returned only after an authenticated,
explicit reveal request. Both views pass through the same string, collection,
object-property, and nesting limits. Aggregate tables are capped after complete
totals are calculated and include omission metadata. Responses use a
restrictive Content Security Policy, same-origin isolation headers, no-referrer
policy, and no-store caching for API data.

### 5. Interface

`public/` contains plain HTML, CSS, JavaScript, and inline SVG charts. It has no
runtime package dependency or remote script. The browser sends the protected
session cookie only to the same-origin loopback server.

The interface includes keyboard navigation, visible focus, reduced-motion
handling, responsive layouts, chart data tables, focus-managed dialogs, and
redacted trajectory pagination.

## Cache and refresh logic

Parsed files are cached by device, inode, size, modification time, and change
time. A changed fingerprint causes a reparse. Dashboard snapshots have a short
in-memory lifetime, hidden tabs stop polling, and forced refreshes are
rate-limited.

The cache stores data only in process memory. RunLume creates no transcript
database and writes nothing into agent state directories.

## Trust boundaries

| Boundary | Guarantee | Not guaranteed |
|---|---|---|
| Agent state | Read-only access, symlink rejection, root containment | Correctness or completeness of vendor transcript formats |
| Import directory | Explicit opt-in, same file and path bounds | Safety of data the user chose to capture |
| Local API | Loopback bind, Host/Origin checks, launch token | Multi-user access control or safe network exposure |
| Browser | Default redaction, bounded payloads, restrictive headers | Safety after the user reveals and copies raw content |
| Pricing | Dated, validated local table and visible unknowns | Invoice accuracy, discounts, regional or special tool charges |

## Extension points

To add a source:

1. implement discovery and parsing in `adapters.mjs`;
2. return normalized sessions and diagnostics;
3. register the adapter in `makeAdapters()`;
4. add synthetic fixtures for every accepted event shape;
5. add analytics and browser coverage for any new visible behavior.

Adapters must remain read-only and tolerant of unknown records. They must never
execute transcript content, load credentials, or send data to a provider.
