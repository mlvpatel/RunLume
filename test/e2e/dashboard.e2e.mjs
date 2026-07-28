import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import axe from 'axe-core';
import { chromium, firefox, webkit } from 'playwright';
import { createDashboard } from '../../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PRICING_FILE = path.join(ROOT, 'pricing.json');
const API_TOKEN = 'e2e_dashboard_token_0123456789_ABCDEFGHIJK';
const BROWSERS = { chromium, firefox, webkit };

function fixtureRows() {
  const baseTime = Date.now() - 5 * 60_000;
  const at = (seconds) => new Date(baseTime + seconds * 1000).toISOString();
  const rows = [
    {
      type: 'init',
      session_id: 'e2e-session',
      model: 'gemini-3-flash-preview',
      timestamp: at(0),
    },
    {
      type: 'message',
      timestamp: at(1),
      role: 'user',
      content: 'Synthetic private E2E prompt',
    },
    {
      type: 'tool_use',
      timestamp: at(2),
      tool_name: 'replace',
      tool_id: 'edit-1',
      parameters: {
        file_path: '/workspace/e2e-project/src/index.js',
        old_string: 'old',
        new_string: 'new',
      },
    },
    {
      type: 'tool_result',
      timestamp: at(3),
      tool_id: 'edit-1',
      status: 'success',
      output: 'Updated src/index.js',
    },
  ];
  for (let index = 0; index < 105; index++) {
    rows.push({
      type: 'message',
      timestamp: at(4 + index),
      role: 'assistant',
      content: `Synthetic response ${index + 1}`,
    });
  }
  rows.push({
    type: 'result',
    timestamp: at(110),
    status: 'success',
    stats: {
      total_tokens: 120,
      input_tokens: 100,
      output_tokens: 20,
      cached: 30,
      input: 70,
      duration_ms: 110_000,
      tool_calls: 1,
      models: {
        'gemini-3-flash-preview': {
          total_tokens: 120,
          input_tokens: 100,
          output_tokens: 20,
          cached: 30,
          input: 70,
        },
      },
    },
  });
  return rows;
}

async function startFixtureDashboard(t) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runlume-e2e-'));
  const hermesRoot = path.join(stateRoot, 'empty-hermes-state');
  const sessionDirectory = path.join(stateRoot, 'tmp', 'e2e-project', 'chats');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.mkdirSync(hermesRoot);
  fs.writeFileSync(
    path.join(sessionDirectory, 'e2e-session.jsonl'),
    `${fixtureRows().map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  const previousGeminiRoot = process.env.GEMINI_STATE_DIR;
  const previousHermesRoot = process.env.HERMES_STATE_DIR;
  process.env.GEMINI_STATE_DIR = stateRoot;
  process.env.HERMES_STATE_DIR = hermesRoot;
  const dashboard = createDashboard({
    config: {
      port: 0,
      days: Infinity,
      sources: ['gemini', 'hermes'],
      pricingFile: PRICING_FILE,
    },
    apiToken: API_TOKEN,
    logger: { log() {}, warn() {}, error() {} },
  });
  await new Promise((resolve, reject) => {
    dashboard.server.once('error', reject);
    dashboard.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => dashboard.server.close(resolve));
    if (previousGeminiRoot == null) delete process.env.GEMINI_STATE_DIR;
    else process.env.GEMINI_STATE_DIR = previousGeminiRoot;
    if (previousHermesRoot == null) delete process.env.HERMES_STATE_DIR;
    else process.env.HERMES_STATE_DIR = previousHermesRoot;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${dashboard.server.address().port}`;
}

async function axeViolations(page) {
  await page.evaluate(axe.source);
  const result = await page.evaluate(async () => globalThis.axe.run(document, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
    },
  }));
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

async function verifyBrowser(browserName, browserType, baseUrl) {
  const browser = await browserType.launch({ headless: true });
  try {
    const context = await browser.newContext({
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${baseUrl}/#token=${API_TOKEN}`);
    await page.waitForFunction(
      () => document.querySelector('#main .hero') || document.querySelector('#roots.load-error'),
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await page.locator('#main .hero').count(),
      1,
      `${browserName}: dashboard did not load; status=${await page.locator('#roots').innerText()}; errors=${errors.join(' | ')}`,
    );
    const hermesTab = page.getByRole('tab', { name: 'Hermes 0', exact: true });
    assert.equal(await hermesTab.count(), 1, `${browserName}: enabled zero-session source`);
    await hermesTab.click();
    await page.getByRole('heading', { name: 'No sessions found' }).waitFor();
    assert.equal(await hermesTab.getAttribute('aria-selected'), 'true', `${browserName}: empty-state filter`);
    await page.getByRole('tab', { name: 'Gemini 1', exact: true }).click();
    await page.locator('#main .hero').waitFor();
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
      'light',
      `${browserName}: dashboard remains light when the operating system prefers dark`,
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        return {
          page: root.getPropertyValue('--page').trim(),
          ink: root.getPropertyValue('--ink').trim(),
          brand: root.getPropertyValue('--brand').trim(),
        };
      }),
      { page: '#f2f5f9', ink: '#101828', brand: '#1e40af' },
      `${browserName}: operations-focused light design tokens`,
    );
    assert.equal(await page.locator('.hero #daily-chart').count(), 1, `${browserName}: live chart is above the fold`);
    assert.equal(await page.locator('.signal-stack .signal-card').count(), 2, `${browserName}: reporting signals`);
    assert.equal(await page.locator('#main .session-strip #tree').count(), 1, `${browserName}: real session stream`);
    assert.equal(await page.locator('#provider-comparison .provider-card').count(), 1, `${browserName}: provider cards`);
    assert.match(
      await page.locator('#provider-comparison').innerText(),
      /Google[\s\S]*Gemini/,
      `${browserName}: provider attribution remains separate from agent source`,
    );
    assert.equal(await page.locator('#punchcard .cell').count(), 168, `${browserName}: rhythm grid`);
    assert.equal((await page.locator('body').innerText()).includes('Synthetic private E2E prompt'), false);
    assert.deepEqual(await axeViolations(page), [], `${browserName}: overview accessibility`);

    await page.locator('.chart-data summary').first().click();
    assert.deepEqual(await axeViolations(page), [], `${browserName}: expanded data-table accessibility`);
    await page.locator('.chart-data summary').first().click();

    await page.locator('#cost-settings').click();
    await page.locator('#plan-dialog[open]').waitFor();
    assert.deepEqual(await axeViolations(page), [], `${browserName}: plan-dialog accessibility`);
    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.locator('#wrapped-btn').click();
    await page.locator('#wrapped[role="dialog"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Close');
    assert.deepEqual(await axeViolations(page), [], `${browserName}: wrapped-dialog accessibility`);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#wrapped').count(), 0, `${browserName}: wrapped closes with Escape`);
    await page.waitForTimeout(100);
    const wrappedFocus = await page.evaluate(() => ({
      activeId: document.activeElement?.id,
      activeTag: document.activeElement?.tagName,
      buttonConnected: Boolean(document.querySelector('#wrapped-btn')?.isConnected),
      headerInert: document.querySelector('header')?.hasAttribute('inert'),
      headerAriaHidden: document.querySelector('header')?.getAttribute('aria-hidden'),
    }));
    assert.equal(wrappedFocus.activeId, 'wrapped-btn', `${browserName}: ${JSON.stringify(wrappedFocus)}`);

    await page.locator('.node-btn').first().click();
    await page.getByRole('heading', { name: 'Trajectory' }).waitFor();
    assert.match(await page.locator('.trajectory-privacy').innerText(), /redacted/i);
    assert.match(await page.locator('.timeline').innerText(), /\[redacted user message\]/);
    assert.match(await page.locator('.trajectory-controls').first().innerText(), /Events 1–100 of 107/);
    assert.deepEqual(await axeViolations(page), [], `${browserName}: trajectory accessibility`);

    await page.getByRole('button', { name: 'Reveal sensitive content' }).click();
    await page.locator('.timeline .body').getByText('Synthetic private E2E prompt', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Next →' }).first().click();
    await page.waitForFunction(
      () => document.querySelector('.trajectory-controls span')?.textContent?.includes('Events 101–107 of 107'),
    );
    assert.match(await page.locator('.trajectory-controls').first().innerText(), /Events 101–107 of 107/);
    assert.deepEqual(errors, [], `${browserName}: console and page errors`);
    await context.close();

    const mobile = await browser.newContext({
      viewport: { width: 375, height: 812 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(`${baseUrl}/#token=${API_TOKEN}`);
    await mobilePage.waitForFunction(
      () => document.querySelector('#main .hero') || document.querySelector('#roots.load-error'),
      null,
      { timeout: 10_000 },
    );
    assert.equal(
      await mobilePage.locator('#main .hero').count(),
      1,
      `${browserName}: mobile dashboard did not load; status=${await mobilePage.locator('#roots').innerText()}`,
    );
    const mobileLayout = await mobilePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      refreshVisible: Boolean(document.querySelector('#refresh')?.getClientRects().length),
      mainVisible: Boolean(document.querySelector('#main')?.getClientRects().length),
      overflowElements: [...document.querySelectorAll('body *')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector: element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${element.className}`,
            left: Math.round(rect.left * 10) / 10,
            right: Math.round(rect.right * 10) / 10,
          };
        })
        .filter(({ left, right }) => left < -0.5 || right > document.documentElement.clientWidth + 0.5)
        .sort((a, b) => Math.max(a.right - document.documentElement.clientWidth, -a.left)
          - Math.max(b.right - document.documentElement.clientWidth, -b.left))
        .slice(0, 12),
    }));
    assert.equal(mobileLayout.refreshVisible, true, `${browserName}: mobile refresh`);
    assert.equal(mobileLayout.mainVisible, true, `${browserName}: mobile main`);
    assert.ok(
      mobileLayout.scrollWidth <= mobileLayout.viewportWidth,
      `${browserName}: mobile layout overflows (${mobileLayout.scrollWidth} > ${mobileLayout.viewportWidth}); ${JSON.stringify(mobileLayout.overflowElements)}`,
    );
    const mobileTargets = await mobilePage.locator('header button:visible').evaluateAll((buttons) => buttons.map((button) => ({
      name: button.textContent.trim() || button.getAttribute('aria-label') || button.id,
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    })));
    assert.ok(
      mobileTargets.every(({ width, height }) => width >= 44 && height >= 44),
      `${browserName}: mobile header touch targets ${JSON.stringify(mobileTargets)}`,
    );
    assert.deepEqual(await axeViolations(mobilePage), [], `${browserName}: mobile accessibility`);
    await mobile.close();

    const landscape = await browser.newContext({
      viewport: { width: 844, height: 390 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const landscapePage = await landscape.newPage();
    await landscapePage.goto(`${baseUrl}/#token=${API_TOKEN}`);
    await landscapePage.waitForFunction(
      () => document.querySelector('#main .hero') || document.querySelector('#roots.load-error'),
      null,
      { timeout: 10_000 },
    );
    const landscapeLayout = await landscapePage.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      headerVisible: Boolean(document.querySelector('header')?.getClientRects().length),
      mainVisible: Boolean(document.querySelector('#main')?.getClientRects().length),
    }));
    assert.equal(landscapeLayout.headerVisible, true, `${browserName}: landscape header`);
    assert.equal(landscapeLayout.mainVisible, true, `${browserName}: landscape main`);
    assert.ok(
      landscapeLayout.scrollWidth <= landscapeLayout.viewportWidth,
      `${browserName}: landscape layout overflows (${landscapeLayout.scrollWidth} > ${landscapeLayout.viewportWidth})`,
    );
    assert.deepEqual(await axeViolations(landscapePage), [], `${browserName}: landscape accessibility`);
    await landscape.close();
  } finally {
    await browser.close();
  }
}

test('dashboard passes cross-browser, responsive, redaction, pagination, and accessibility checks', async (t) => {
  const baseUrl = await startFixtureDashboard(t);
  const selected = process.env.E2E_BROWSER
    ? [process.env.E2E_BROWSER]
    : Object.keys(BROWSERS);
  for (const browserName of selected) {
    const browserType = BROWSERS[browserName];
    assert.ok(browserType, `unsupported E2E_BROWSER: ${browserName}`);
    await t.test(browserName, () => verifyBrowser(browserName, browserType, baseUrl));
  }
});
