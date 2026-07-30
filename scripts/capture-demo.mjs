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
const tour = path.join(docs, 'runlume-tour.mp4');
const temporaryTour = path.join(docs, `.runlume-tour-${process.pid}.tmp.mp4`);
const subtitles = path.join(docs, 'runlume-tour.en.vtt');
const transcript = path.join(docs, 'runlume-tour-script.md');
const capturePort = 45_873;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function runProcess(command, args, { cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
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
      else reject(new Error(`${path.basename(command)} failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

const runNode = (args) => runProcess(process.execPath, args);

function executable(candidates, label) {
  for (const candidate of candidates.filter(Boolean)) {
    const resolved = path.resolve(candidate);
    try {
      fs.accessSync(resolved, fs.constants.X_OK);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      // Try the next explicit path.
    }
  }
  const variable = label === 'FFprobe' ? 'RUNLUME_FFPROBE' : 'RUNLUME_FFMPEG';
  throw new Error(
    `${label} is required. Set ${variable} to an absolute executable path or install FFmpeg.`,
  );
}

function narrationText() {
  return fs.readFileSync(transcript, 'utf8')
    .replace(/^#.*\r?\n+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function narrationFile() {
  if (process.env.RUNLUME_NARRATION_FILE?.trim()) {
    const supplied = fs.realpathSync(path.resolve(process.env.RUNLUME_NARRATION_FILE));
    assert.equal(fs.statSync(supplied).isFile(), true, 'RUNLUME_NARRATION_FILE must be a file');
    return supplied;
  }
  if (process.platform !== 'darwin') {
    throw new Error('Set RUNLUME_NARRATION_FILE when capturing outside macOS.');
  }
  const output = path.join(captureDirectory, 'runlume-tour-narration.aiff');
  await runProcess('/usr/bin/say', [
    '-v',
    process.env.RUNLUME_NARRATOR?.trim() || 'Samantha',
    '-r',
    '240',
    '-o',
    output,
    narrationText(),
  ]);
  return output;
}

async function buildTour() {
  const ffmpeg = executable([
    process.env.RUNLUME_FFMPEG,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ], 'Full FFmpeg');
  const ffprobe = executable([
    process.env.RUNLUME_FFPROBE,
    path.join(path.dirname(ffmpeg), 'ffprobe'),
    '/opt/homebrew/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/usr/bin/ffprobe',
  ], 'FFprobe');
  const narration = await narrationFile();
  try {
    await runProcess(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      rawVideo,
      '-i',
      narration,
      '-i',
      subtitles,
      '-filter_complex',
      '[0:v]tpad=stop_mode=clone:stop_duration=1[v];[1:a]apad=pad_dur=1[a]',
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-map',
      '2:0',
      '-t',
      '29.6',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '22',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ac',
      '1',
      '-ar',
      '44100',
      '-c:s',
      'mov_text',
      '-metadata:s:s:0',
      'language=eng',
      '-metadata:s:s:0',
      'title=English',
      '-movflags',
      '+faststart',
      temporaryTour,
    ]);
    const inspection = JSON.parse(await runProcess(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_name,codec_type:format=duration',
      '-of',
      'json',
      temporaryTour,
    ]));
    const codecs = new Set(inspection.streams?.map((stream) => stream.codec_name));
    for (const codec of ['h264', 'aac', 'mov_text']) {
      assert.equal(codecs.has(codec), true, `tour is missing its ${codec} stream`);
    }
    const duration = Number(inspection.format?.duration);
    assert.equal(duration >= 29.5 && duration <= 29.7, true, 'tour duration must be 29.6 seconds');
    fs.renameSync(temporaryTour, tour);
  } finally {
    fs.rmSync(temporaryTour, { force: true });
  }
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
      const match = output.match(new RegExp(`http://127\\.0\\.0\\.1:${capturePort}/`));
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
  await buildTour();
  console.log(`Screenshot: ${preview}`);
  console.log(`Provider screenshot: ${providerPreview}`);
  console.log(`Narrated tour: ${tour}`);
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode == null) {
    server.kill('SIGTERM');
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 2_000);
    });
  }
  fs.rmSync(captureDirectory, { recursive: true, force: true });
}
