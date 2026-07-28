#!/usr/bin/env node
/**
 * Generate opt-in, synthetic API-log sessions for the real RunLume dashboard.
 * The data is fictional and contains no account, credential, or local path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(root, 'sample-data');
const outputFile = path.join(outputDirectory, 'runlume-demo.jsonl');
const baseTime = Date.parse('2026-07-14T09:00:00Z');
let minute = 0;

const at = (offset = 0) => new Date(baseTime + (minute + offset) * 60_000).toISOString();
const usage = (input, output, cached = 0) => ({
  input_tokens: input,
  output_tokens: output,
  input_tokens_details: { cached_tokens: cached },
});

function response(model, text, tokens, tool = null, reasoning = null) {
  return {
    model,
    choices: [{
      message: {
        role: 'assistant',
        content: text,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(tool ? {
          tool_calls: [{
            id: tool.id,
            type: 'function',
            function: {
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          }],
        } : {}),
      },
    }],
    usage: tokens,
  };
}

function sessionRows({
  provider,
  id,
  model,
  prompt,
  thinking,
  firstReply,
  tool,
  toolResult,
  finalReply,
  correction = null,
  failed = false,
  tokens = [2200, 260, 900],
}) {
  const rows = [{
    provider,
    session_id: id,
    timestamp: at(),
    cwd: '/workspace/runlume-demo',
    request: {
      model,
      messages: [{ role: 'user', content: prompt }],
    },
    response: response(
      model,
      firstReply,
      usage(tokens[0], tokens[1], tokens[2]),
      tool,
      thinking,
    ),
  }];

  if (tool) {
    rows.push({
      provider,
      session_id: id,
      timestamp: at(2),
      cwd: '/workspace/runlume-demo',
      request: {
        model,
        messages: [
          { role: 'assistant', content: firstReply },
          {
            role: 'tool',
            tool_call_id: tool.id,
            content: toolResult,
            is_error: failed,
          },
        ],
      },
      response: response(model, finalReply, usage(740, 120, 420)),
      ...(failed ? { error: { message: toolResult } } : {}),
    });
  }

  if (correction) {
    rows.push({
      provider,
      session_id: id,
      timestamp: at(4),
      cwd: '/workspace/runlume-demo',
      request: {
        model,
        messages: [
          { role: 'assistant', content: finalReply ?? firstReply },
          { role: 'user', content: correction.prompt },
        ],
      },
      response: response(model, correction.reply, usage(680, 96, 310)),
    });
  }

  // Space synthetic sessions across the reporting window so the real dashboard
  // exercises its time-series, activity, and recency views.
  minute += 36 * 60;
  return rows;
}

const sessions = [
  {
    provider: 'nvidia',
    id: 'nemotron-security-review',
    model: 'nvidia/nemotron',
    prompt: 'Audit the request boundary and make the host validation easier to reason about.',
    thinking: 'Trace the value from the HTTP Host header through parsing, port checks, and the loopback allowlist.',
    firstReply: 'The boundary is sound, but the validation should be expressed as one explicit guard.',
    tool: {
      id: 'nemotron-patch',
      name: 'apply_patch',
      arguments: {
        input: '*** Begin Patch\n*** Update File: server.mjs\n@@\n-  return local && validPort;\n+  return Boolean(local && validPort);\n*** End Patch',
      },
    },
    toolResult: 'Done!',
    finalReply: 'Host validation now has one auditable boolean exit path.',
  },
  {
    provider: 'moonshot',
    id: 'kimi-parser-refactor',
    model: 'kimi-k3',
    prompt: 'Refactor the import parser so unknown fields remain harmless and visible in diagnostics.',
    thinking: 'Keep the parser tolerant while preserving strict resource and type bounds.',
    firstReply: 'I will isolate the fallback path and add an explicit diagnostic counter.',
    tool: {
      id: 'kimi-edit',
      name: 'edit',
      arguments: {
        path: '/workspace/runlume-demo/adapters.mjs',
        old_string: 'if (!identity) return;',
        new_string: 'if (!identity) { diagnostics.invalidRows++; return; }',
      },
    },
    toolResult: 'Updated adapters.mjs.',
    finalReply: 'Unknown provider rows are skipped deterministically and counted.',
  },
  {
    provider: 'zhipu',
    id: 'glm-refresh-fix',
    model: 'glm-5.2',
    prompt: 'Fix the refresh loop so hidden tabs never trigger overlapping scans.',
    thinking: 'The timer and visibility event can race; one in-flight guard should own refresh.',
    firstReply: 'I found the overlap and will gate both entry points with the same promise.',
    tool: {
      id: 'glm-edit',
      name: 'edit',
      arguments: {
        path: '/workspace/runlume-demo/public/app.js',
        old_string: 'refreshDashboard();',
        new_string: 'refreshInFlight ??= refreshDashboard();',
      },
    },
    toolResult: 'Updated public/app.js.',
    finalReply: 'Refreshes are now serialized across timer and visibility events.',
    correction: {
      prompt: 'No, keep manual refresh responsive even while the polling timer is waiting.',
      reply: 'Adjusted: manual refresh cancels the pending poll, then starts one bounded scan.',
    },
  },
  {
    provider: 'alibaba',
    id: 'qwen-accessibility-docs',
    model: 'qwen-3.6',
    prompt: 'Add a concise accessibility note explaining keyboard navigation and chart tables.',
    thinking: 'Document the behavior users can verify without overstating compliance.',
    firstReply: 'I will add a short, testable accessibility section.',
    tool: {
      id: 'qwen-write',
      name: 'write',
      arguments: {
        path: '/workspace/runlume-demo/docs/accessibility.md',
        content: '# Accessibility\n\nUse Tab to reach controls. Every chart has a data table.',
      },
    },
    toolResult: 'Wrote docs/accessibility.md.',
    finalReply: 'The note now covers keyboard access, focus, reduced motion, and chart alternatives.',
  },
  {
    provider: 'mistral',
    id: 'mistral-test-triage',
    model: 'mistral-large',
    prompt: 'Run the package smoke test and explain any failure before changing code.',
    thinking: 'Reproduce first, then separate packaging defects from environment failures.',
    firstReply: 'I will run the packed install check without modifying source.',
    tool: {
      id: 'mistral-test',
      name: 'exec',
      arguments: { command: 'npm run test:package' },
    },
    toolResult: 'Registry connection timed out after 30 seconds.',
    finalReply: 'The failure is environmental; no source change was made. Retry with registry access.',
    failed: true,
  },
  {
    provider: 'openai',
    id: 'codex-codeql-fix',
    model: 'gpt-5.3-codex',
    prompt: 'Fix the unsafe dynamic regular expression in pricing lookup and add regression coverage.',
    thinking: 'Replace executable patterns with declarative model aliases and validated date suffixes.',
    firstReply: 'I will remove dynamic RegExp construction from the pricing path.',
    tool: {
      id: 'codex-patch',
      name: 'apply_patch',
      arguments: {
        input: '*** Begin Patch\n*** Update File: analytics.mjs\n@@\n-  return new RegExp(pattern).test(model);\n+  return modelAliases.includes(model);\n*** End Patch',
      },
    },
    toolResult: 'Done!',
    finalReply: 'Pricing lookup now uses bounded declarative aliases, with no executable pattern input.',
  },
  {
    provider: 'anthropic',
    id: 'claude-architecture-review',
    model: 'claude-opus-4-8',
    prompt: 'Review the local-first architecture and identify the most important trust boundary.',
    thinking: 'The dashboard reads sensitive local transcripts, so the loopback API boundary matters most.',
    firstReply: 'The critical boundary is between transcript files and browser-visible API responses.',
    tool: null,
    toolResult: null,
    finalReply: null,
    tokens: [1800, 190, 760],
  },
  {
    provider: 'local',
    id: 'local-abandoned-run',
    model: 'qwen-3.6-local',
    prompt: 'Prototype a compact timeline card for the session detail view.',
    thinking: null,
    firstReply: '',
    tool: null,
    toolResult: null,
    finalReply: null,
    tokens: [0, 0, 0],
  },
];

const rows = sessions.flatMap((spec) => sessionRows(spec));
fs.rmSync(outputDirectory, { recursive: true, force: true });
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
fs.writeFileSync(outputFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, {
  mode: 0o600,
});

console.log(`Synthetic API-log demo written to ${outputFile}`);
console.log(`${sessions.length} sessions across NVIDIA, Moonshot AI, Zhipu AI, Alibaba Cloud, Mistral, OpenAI, Anthropic, and local inference`);
