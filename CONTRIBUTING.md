# Contributing

## Development

Use a supported Node.js LTS release (22 or 24).

```bash
npm run check
npm test
npm run sample
```

For frontend, accessibility, packaging, or release changes, also run:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium firefox webkit
pnpm run test:e2e
npm run test:package
```

Changes to an adapter should include synthetic fixtures for every accepted
event shape. Changes to analytics should include exact expected metrics,
including unknown or malformed input. Server changes should preserve loopback
binding, Host/Origin validation, security headers, read-only behaviour, and
bounded responses. UI changes should preserve the light theme under both
operating-system colour preferences and pass desktop, small-phone, and
landscape WCAG checks in all three browser engines.

Never commit real agent transcripts, prompts, reasoning, tool results, local
paths, credentials, or screenshots produced from private data.

Cursor fixtures must use synthetic native `role`/`message` records or the
documented CLI `stream-json` event shape. Native Cursor records have no event
timestamps or token usage, so tests must not fabricate either as source data.

Gemini fixtures must use synthetic native chat-recording JSONL or documented
headless `stream-json` events. Cover metadata updates, model/token usage, tool
outcomes, and nested subagent records when those shapes change.

API/local fixtures must use the documented import wrapper and synthetic
OpenAI, Anthropic, Ollama, or LM Studio request/response objects. Never include
authorization headers, API keys, real prompts, account IDs, or captured private
responses.

## Pull requests

Keep changes focused, explain user-visible metric changes, update the README and
changelog, and include the commands used for validation.
