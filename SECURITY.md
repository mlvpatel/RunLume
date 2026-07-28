# Security policy

## Supported versions

Security fixes are applied to the latest released version. Supported releases require Node.js 22 or 24; do not run the dashboard on an end-of-life Node.js line.

## Reporting a vulnerability

Do not open a public issue containing transcript data, local paths, prompts,
tool arguments, credentials, or exploit details. Use the repository host's
private vulnerability-reporting feature.

Include the affected version, reproduction steps using synthetic data, impact,
and any proposed mitigation. Remove secrets and personal data before sending a
report. Do not attach a real transcript, screenshot, raw API response, or local
state directory.

## Local threat model

The dashboard reads sensitive agent transcripts and intentionally serves them
only on the loopback interface. It rejects non-local Host and Origin values,
requires a random per-launch Bearer token for API requests, and redacts
transcript content by default. Do not expose its port through a reverse proxy,
tunnel, container port publication, or network-forwarding rule without adding
transport security and reviewing the authentication boundary.

Transcript, pricing, and static-file symbolic links are rejected. Discovered
real paths must remain inside the configured transcript or static root. A scan
is bounded by per-file, aggregate-byte, file-count, event-count, and
session-count limits; forced rescans are rate-limited. These controls reduce
accidental resource exhaustion and path escape, but they do not make an exposed
dashboard a multi-user service.
