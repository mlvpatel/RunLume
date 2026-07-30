import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const EXPECTED_FILES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'package-files.json'), 'utf8'),
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-package-'));
const archiveDirectory = path.join(temporary, 'archive');
const installDirectory = path.join(temporary, 'install');
fs.mkdirSync(archiveDirectory);
fs.mkdirSync(installDirectory);

function managerCommand(args, cwd, extraEnvironment = {}) {
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
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', ...extraEnvironment },
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

function archiveFiles(archive) {
  const tar = gunzipSync(fs.readFileSync(archive));
  const files = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, length) => header
      .subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/s, '');
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const sizeText = readString(124, 12).trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    assert.equal(Number.isSafeInteger(size) && size >= 0, true, `invalid tar size for ${name}`);
    const type = String.fromCharCode(header[156] || 0);
    if (type === '\0' || type === '0') files.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files.sort();
}

try {
  managerCommand(
    ['pack', '--pack-destination', archiveDirectory],
    ROOT,
    { npm_config_ignore_scripts: 'true' },
  );
  const archives = fs.readdirSync(archiveDirectory).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'pack must create exactly one archive');
  const archive = path.join(archiveDirectory, archives[0]);
  assert.deepEqual(
    archiveFiles(archive),
    [...EXPECTED_FILES].sort(),
    'packed file list must match scripts/package-files.json exactly',
  );

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
  assert.equal(fs.existsSync(path.join(installedRoot, 'public', 'favicon.svg')), true);
  assert.equal(fs.existsSync(path.join(installedRoot, 'docs', 'architecture.md')), true);
  assert.equal(fs.existsSync(path.join(installedRoot, 'docs', 'reference.md')), true);
  assert.equal(fs.existsSync(path.join(installedRoot, 'test')), false, 'tests must not ship');

  const version = spawnSync(process.execPath, [server, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), PACKAGE.version);
  const help = spawnSync(process.execPath, [server, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /RunLume/);
  const bin = path.join(
    installDirectory,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'runlume.cmd' : 'runlume',
  );
  assert.equal(fs.existsSync(bin), true, 'installed package must expose the runlume bin');
  const binVersion = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  assert.equal(binVersion.status, 0, binVersion.stderr);
  assert.equal(binVersion.stdout.trim(), PACKAGE.version);

  console.log(`Packed, installed, and executed ${PACKAGE.name}@${PACKAGE.version}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
