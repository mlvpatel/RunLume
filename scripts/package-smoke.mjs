import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-package-'));
const archiveDirectory = path.join(temporary, 'archive');
const installDirectory = path.join(temporary, 'install');
fs.mkdirSync(archiveDirectory);
fs.mkdirSync(installDirectory);

function managerCommand(args, cwd) {
  const configuredScript = process.env.npm_execpath;
  assert.ok(configuredScript, 'run this check through npm or pnpm');
  const managerScript = fs.realpathSync(configuredScript);
  assert.match(managerScript, /\.[cm]?js$/i, 'package manager entry point must be a JavaScript file');
  const result = spawnSync(
    process.execPath,
    [managerScript, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      shell: false,
    },
  );
  assert.equal(
    result.status,
    0,
    `package-manager command failed: ${args.join(' ')}\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}

try {
  managerCommand(['pack', '--pack-destination', archiveDirectory], ROOT);
  const archives = fs.readdirSync(archiveDirectory).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'pack must create exactly one archive');
  const archive = path.join(archiveDirectory, archives[0]);

  fs.writeFileSync(
    path.join(installDirectory, 'package.json'),
    JSON.stringify({ name: 'runlume-package-smoke', private: true }),
  );
  const isPnpm = path.basename(process.env.npm_execpath).includes('pnpm');
  const installArgs = isPnpm
    ? ['add', '--dir', installDirectory, '--ignore-scripts', archive]
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive];
  managerCommand(installArgs, installDirectory);

  const installedRoot = path.join(installDirectory, 'node_modules', PACKAGE.name);
  const server = path.join(installedRoot, 'server.mjs');
  assert.equal(fs.existsSync(server), true, 'installed package must contain server.mjs');
  assert.equal(fs.existsSync(path.join(installedRoot, 'public', 'index.html')), true);
  assert.equal(fs.existsSync(path.join(installedRoot, 'test')), false, 'tests must not ship');

  const version = spawnSync(process.execPath, [server, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), PACKAGE.version);
  const help = spawnSync(process.execPath, [server, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /RunLume/);

  console.log(`Packed, installed, and executed ${PACKAGE.name}@${PACKAGE.version}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
