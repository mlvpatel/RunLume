#!/usr/bin/env node
/**
 * Syntax-check every split module under adapters/ and analytics/ and fail
 * when any source module grows past the documented size budget.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAX_MODULE_LINES = 800;
const DIRECTORIES = ['adapters', 'analytics'];

let failed = false;
for (const directory of DIRECTORIES) {
  const absolute = path.join(ROOT, directory);
  const entries = fs.readdirSync(absolute).filter((name) => name.endsWith('.mjs')).sort();
  if (!entries.length) {
    console.error(`error: no modules found in ${directory}/`);
    failed = true;
    continue;
  }
  for (const name of entries) {
    const file = path.join(absolute, name);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      const stderr = typeof error?.stderr === 'string'
        ? error.stderr
        : Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8') : '';
      const message = error instanceof Error ? error.message : String(error);
      console.error(`error: syntax check failed for ${directory}/${name}\n${stderr || message}`);
      failed = true;
      continue;
    }
    const lineTotal = fs.readFileSync(file, 'utf8').split('\n').length;
    if (lineTotal > MAX_MODULE_LINES) {
      console.error(`error: ${directory}/${name} has ${lineTotal} lines; the budget is ${MAX_MODULE_LINES}`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
