import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
function loadPlaywright() {
  try {
    return require('playwright');
  } catch (primaryError) {
    const bundled = join(
      homedir(),
      '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
    );
    try {
      return require(bundled);
    } catch {
      const error = new Error('Playwright is required for dashboard browser QA. Install it as a development dependency or run this check inside Codex Desktop.');
      error.cause = primaryError;
      throw error;
    }
  }
}
const { chromium } = loadPlaywright();
const baseUrl = process.env.AIPRO_DASHBOARD_URL || 'http://127.0.0.1:17655/';
const outputDir = process.env.AIPRO_UI_OUTPUT || '/tmp/aipro-dashboard-ui';
mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const resourceErrors = [];
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', error => consoleErrors.push(error.message));
page.on('requestfailed', request => resourceErrors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`));
page.on('response', response => {
  if (response.status() >= 400) resourceErrors.push(`${response.status()} ${response.url()}`);
});

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('aipro.locale'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#hero[data-state]:not([data-state="loading"])');

  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await page.title(), /Human-Identity AI Operations/);
  assert.equal(await page.locator('#languageCode').textContent(), 'EN');
  assert.match(await page.locator('.channel-heading h3').textContent(), /Messaging channels/);
  assert.equal(await page.locator('.brand-credit').textContent(), 'Developed by Zhao Yingzhi & James Feng');
  assert.equal(await page.locator('.product-footer strong').textContent(), 'Developed by Zhao Yingzhi & James Feng');
  assert.match(await page.locator('#configInput').getAttribute('placeholder'), /Describe the outcome/);
  assert.equal(await page.locator('#refreshButton').isEnabled(), true);

  const cardRadius = await page.locator('.channel-card').first().evaluate(element => getComputedStyle(element).borderRadius);
  assert.equal(cardRadius, '16px');
  await page.screenshot({ path: `${outputDir}/dashboard-en.png`, fullPage: true });

  await page.setViewportSize({ width: 2000, height: 1200 });
  await page.screenshot({ path: `${outputDir}/dashboard-wide-en.png`, fullPage: true });

  await page.locator('#languageToggle').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
  assert.equal(await page.locator('#languageCode').textContent(), '中');
  assert.match(await page.locator('.channel-heading h3').textContent(), /IM 通道/);
  assert.match(await page.locator('.product-footer strong').textContent(), /赵颖知.*James Feng/);

  await page.locator('#languageToggle').click();
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('[data-channel-open="dingtalk"]').click();
  await page.locator('#channelDialog[open]').waitFor();
  assert.match(await page.locator('#channelDialogTitle').textContent(), /DingTalk/);
  assert.match(await page.locator('#channelTestButton').textContent(), /Test connection/);
  await page.locator('#channelDialogClose').click();
  assert.equal(await page.locator('#channelDialog').getAttribute('open'), null);

  await page.locator('#configInput').fill('Keep replies concise');
  assert.equal(await page.locator('#configInput').inputValue(), 'Keep replies concise');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${outputDir}/dashboard-mobile-en.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.equal(overflow <= 1, true, `mobile layout has ${overflow}px horizontal overflow`);
  assert.equal(await page.locator('#languageToggle').isVisible(), true);

  const textOverflow = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter(element => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (!String(element.textContent || '').trim() || element.children.length) return false;
      if (['TEXTAREA', 'INPUT', 'PRE'].includes(element.tagName)) return false;
      if (element.classList.contains('brand-mark')) return false;
      if (!['hidden', 'clip'].includes(style.overflowX)
        && !['hidden', 'clip'].includes(style.overflowY)) return false;
      if (style.textOverflow === 'ellipsis' || ['auto', 'scroll'].includes(style.overflowY)) return false;
      return element.scrollWidth - element.clientWidth > 1 || element.scrollHeight - element.clientHeight > 1;
    })
    .map(element => ({
      tag: element.tagName,
      id: element.id,
      className: element.className,
      text: String(element.textContent || '').trim().slice(0, 100),
      widthOverflow: element.scrollWidth - element.clientWidth,
      heightOverflow: element.scrollHeight - element.clientHeight,
    })));
  assert.deepEqual(textOverflow, [], `visible text overflow detected: ${JSON.stringify(textOverflow)}`);
  const unexpectedCjk = await page.evaluate(() => document.body.innerText
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => /[\u3400-\u9fff]/.test(line)));
  assert.deepEqual(unexpectedCjk, [], `English UI contains visible CJK text: ${JSON.stringify(unexpectedCjk)}`);

  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(resourceErrors, []);
  const report = {
    ok: true,
    locale: 'en',
    viewports: ['1440x1100', '2000x1200', '390x844'],
    screenshots: [
      `${outputDir}/dashboard-en.png`,
      `${outputDir}/dashboard-wide-en.png`,
      `${outputDir}/dashboard-mobile-en.png`,
    ],
    consoleErrors,
    resourceErrors,
    visibleTextOverflow: textOverflow,
    unexpectedCjk,
    horizontalOverflowPx: overflow,
  };
  writeFileSync(`${outputDir}/qa-report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('DASHBOARD_BROWSER_SMOKE_OK');
} finally {
  await browser.close();
}
