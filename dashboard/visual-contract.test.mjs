import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/dashboard-server.mjs', import.meta.url), 'utf8');

const htmlIds = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const uniqueIds = new Set(htmlIds);
assert.equal(uniqueIds.size, htmlIds.length, 'dashboard HTML IDs must stay unique');

const appDomIds = [...app.matchAll(/\$\('([^']+)'\)/g)].map(match => match[1]);
for (const id of new Set(appDomIds)) {
  assert.equal(uniqueIds.has(id), true, `app.js DOM hook #${id} must exist in index.html`);
}

for (const requiredId of [
  'refreshButton',
  'restartButton',
  'configForm',
  'channelForm',
  'channelTestButton',
  'channelSaveButton',
  'wechatPocToggle',
  'wechatPocEmergencyStop',
  'languageToggle',
  'contactDeveloperButton',
  'contactDeveloperLabel',
  'learningConsole',
  'learningRunButton',
  'learningTotal',
  'learningNext',
  'learningStatus',
  'learningTasks',
  'learningSkills',
  'learningErrors',
  'learningSummary',
  'learningHistory',
]) {
  assert.equal(uniqueIds.has(requiredId), true, `required control #${requiredId} must remain mounted`);
}

for (const endpoint of [
  '/api/status',
  '/api/restart',
  '/api/config',
  '/api/channels/test',
  '/api/channels/configure',
  '/api/config/plan',
  '/api/config/apply',
  '/api/config/rollback',
  '/api/wechat-poc/control',
  '/api/wechat-poc/emergency-stop',
  '/api/wechat-poc/open-client',
  '/api/learning/run',
]) {
  assert.match(app, new RegExp(endpoint.replaceAll('/', '\\/')), `existing endpoint ${endpoint} must remain wired`);
}

assert.match(html, /<html lang="en">/);
assert.match(html, /id="languageToggle"/);
assert.equal((html.match(/Developed by Zhao Yingzhi &amp; James Feng/g) || []).length, 1);
assert.match(html, /class="brand-mark" role="img" aria-label="AIPRO emblem"/);
assert.match(html, /<h1 data-i18n="brandName">AIPRO<\/h1>/);
assert.doesNotMatch(html, /Achong|阿充/i, 'AIPRO must remain the product brand');
assert.match(css, /grid-template-columns:[^;]*minmax\(260px,[^;]*minmax\(280px,/);
assert.doesNotMatch(html, /<div class="brand">[\s\S]{0,900}data-i18n="brandCredit"/);
assert.doesNotMatch(html, /<span class="brand-mark">AI<\/span>/);
assert.match(server, /\['\/i18n\.js', \['i18n\.js', 'text\/javascript; charset=utf-8'\]\]/);
assert.doesNotMatch(html, /[\u3400-\u9fff]/, 'default server-rendered UI must be English');
assert.match(css, /--accent:\s*#9a5b4d/);
assert.match(css, /\.brand-arch-outer\s*\{[\s\S]*stroke:\s*var\(--accent\)/);
assert.match(css, /\.brand-arch-inner\s*\{[\s\S]*stroke:\s*var\(--accent\)/);
assert.doesNotMatch(css, /--blue:/, 'the brand system should not introduce a competing blue accent');
assert.match(css, /backdrop-filter:\s*blur/);
assert.match(css, /@media \(max-width: 560px\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.match(app, /channel\.capabilities/, 'channel cards must expose text, image, audio and link readiness');

assert.doesNotMatch(html, /class="runtime-current"/, 'effective runtime should be expressed only by the selected card');
assert.doesNotMatch(html, /data-card="codex"/, 'runtime must not be repeated in the summary metrics');
assert.doesNotMatch(html, /class="runtime-contract"/, 'internal switching workflow should not repeat below the cards');
assert.doesNotMatch(app, /id:\s*'auto'/, 'automatic discovery is an implementation policy, not a runtime card');
assert.match(app, /runtime\.id === selectedId/);

console.log('DASHBOARD_VISUAL_CONTRACT_TEST_OK');
