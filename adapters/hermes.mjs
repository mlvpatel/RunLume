import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  parseGenericAgentFile,
  walkJsonl,
} from './shared.mjs';

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
