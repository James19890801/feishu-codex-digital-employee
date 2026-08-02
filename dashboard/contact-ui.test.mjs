import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../src/dashboard-server.mjs', import.meta.url), 'utf8');

for (const id of [
  'contactDeveloperButton',
  'contactDeveloperLabel',
  'contactDeveloperMeta',
  'contactDialog',
  'contactDialogClose',
  'contactCardImage',
  'contactCardRetry',
  'contactCardError',
]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.match(html, /class="brand-campaign"/);
assert.match(html, /data-i18n="brandCampaignTitle"/);
assert.match(html, /data-i18n="brandCampaignMeta"/);
assert.match(html, /aria-labelledby="contactDialogTitle"/);
assert.match(app, /\/api\/licensing\/contact-card/);
assert.match(server, /\/api\/licensing\/contact-card/);
assert.doesNotMatch(html, /data:image\/jpeg;base64/);
assert.doesNotMatch(html, /codex-clipboard-65ec74b0/);

console.log('CONTACT_UI_TEST_OK');
