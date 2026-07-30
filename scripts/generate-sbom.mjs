import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const configuredScript = process.env.npm_execpath;
assert.ok(configuredScript, 'run this command through npm or pnpm');
const managerScript = fs.realpathSync(configuredScript);
assert.match(managerScript, /\.[cm]?js$/i, 'package manager entry point must be JavaScript');

const listed = spawnSync(
  process.execPath,
  [managerScript, 'list', '--json', '--depth', 'Infinity'],
  {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
    shell: false,
  },
);
assert.equal(listed.status, 0, `dependency listing failed\n${listed.stdout}\n${listed.stderr}`);
const [rootNode] = JSON.parse(listed.stdout);
assert.ok(rootNode && typeof rootNode === 'object', 'dependency listing did not return a root package');

function npmPurl(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

const rootRef = npmPurl(PACKAGE.name, PACKAGE.version);
const components = new Map();
const relationships = new Map([[rootRef, new Set()]]);

function collect(dependencies, parentRef) {
  for (const [name, dependency] of Object.entries(dependencies ?? {})) {
    if (!dependency || typeof dependency.version !== 'string') continue;
    const reference = npmPurl(name, dependency.version);
    if (!components.has(reference)) {
      components.set(reference, {
        type: 'library',
        'bom-ref': reference,
        name,
        version: dependency.version,
        purl: reference,
        scope: 'excluded',
      });
    }
    if (!relationships.has(parentRef)) relationships.set(parentRef, new Set());
    relationships.get(parentRef).add(reference);
    if (!relationships.has(reference)) relationships.set(reference, new Set());
    collect(dependency.dependencies, reference);
  }
}

collect(rootNode.dependencies, rootRef);
collect(rootNode.optionalDependencies, rootRef);
collect(rootNode.devDependencies, rootRef);

const outputArguments = process.argv.slice(2).filter((argument) => argument !== '--');
assert.ok(outputArguments.length <= 1, 'provide at most one SBOM output path');
const output = path.resolve(outputArguments[0] ?? 'runlume.cdx.json');
const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      'bom-ref': rootRef,
      name: PACKAGE.name,
      version: PACKAGE.version,
      purl: rootRef,
    },
  },
  components: [...components.values()].sort((left, right) => (
    left['bom-ref'].localeCompare(right['bom-ref'])
  )),
  dependencies: [...relationships.entries()]
    .map(([reference, children]) => ({
      ref: reference,
      dependsOn: [...children].sort(),
    }))
    .sort((left, right) => left.ref.localeCompare(right.ref)),
};

fs.writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote CycloneDX SBOM to ${output}`);
