import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const captureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-capture-'));
const rawVideo = path.join(captureDirectory, 'runlume-tour.webm');
const preview = path.join(docs, 'runlume-preview.png');
const providerPreview = path.join(docs, 'runlume-providers.png');
const capturePort = 45_873;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${args.join(' ')} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

function startServer() {
  const child = spawn(process.execPath, [
    'server.mjs',
    '--import-dir',
    'sample-data',
    '--sources',
    'api-log',
    '--all',
    '--port',
    String(capturePort),
  ], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  const launchUrl = new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('RunLume did not start within 10 seconds')), 10_000);
    const inspect = (chunk) => {
      output += String(chunk);
      const match = output.match(new RegExp(`http://127\\.0\\.0\\.1:${capturePort}/#token=[A-Za-z0-9_-]+`));
      if (!match) return;
      clearTimeout(timer);
      resolve(match[0]);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`RunLume server exited before capture (${code})\n${output}`));
      }
    });
  });
  return { child, launchUrl };
}

let browser;
let server;
await runNode(['sample/generate.mjs']);

try {
  const started = startServer();
  server = started.child;
  const launchUrl = await started.launchUrl;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: captureDirectory,
      size: { width: 1440, height: 900 },
    },
  });
  const page = await context.newPage();
  const video = page.video();
  await page.goto(launchUrl, { waitUntil: 'networkidle' });
  await page.locator('.hero').waitFor({ state: 'visible' });
  await page.screenshot({ path: preview, animations: 'disabled' });

  await wait(3_500);
  await page.locator('#cost-intelligence').scrollIntoViewIfNeeded();
  await wait(4_500);
  await page.locator('#provider-panel').scrollIntoViewIfNeeded();
  await wait(5_500);
  await page.locator('#provider-panel').screenshot({
    path: providerPreview,
    animations: 'disabled',
  });
  await page.locator('#impact-chart').scrollIntoViewIfNeeded();
  await wait(4_500);
  await page.locator('#tree .node-btn').nth(2).click();
  await page.locator('#trajectory').waitFor({ state: 'visible' });
  await wait(6_000);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await wait(3_500);

  await context.close();
  const recorded = await video.path();
  assert.equal(fs.existsSync(recorded), true, 'Playwright did not produce a recording');
  fs.copyFileSync(recorded, rawVideo);
  console.log(`Screenshot: ${preview}`);
  console.log(`Provider screenshot: ${providerPreview}`);
  console.log(`Raw video: ${rawVideo}`);
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode == null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
}
