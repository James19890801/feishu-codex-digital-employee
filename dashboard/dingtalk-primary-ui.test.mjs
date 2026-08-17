import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const i18n = await readFile(new URL('./i18n.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../src/dashboard-server.mjs', import.meta.url), 'utf8');

assert.ok(
  html.indexOf('data-channel="enterpriseChat"') < html.indexOf('data-channel="feishu"'),
  'DingTalk must be the first channel shown to learners',
);
assert.match(html, /data-channel="enterpriseChat"[\s\S]{0,240}<span>PRIMARY<\/span>/u);
assert.match(html, /DingTalk \/ DWS Channel/u);
assert.match(app, /URLSearchParams[\s\S]*setup[\s\S]*dingtalk/u);
assert.match(i18n, /enterpriseChatName:\s*'钉钉 \/ DWS Channel'/u);
assert.doesNotMatch(i18n, /enterpriseChatMeta:\s*'[^']*CONNECTOR/iu);
assert.match(server, /process\.platform === 'win32'[\s\S]*schtasks\.exe/u);
assert.match(server, /process\.platform === 'linux'[\s\S]*systemctl/u);

console.log('DINGTALK_PRIMARY_UI_TEST_OK');
