import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const asset = name => readFile(path.join(directory, name), 'utf8');

test('service is isolated from the existing website and binds loopback only', async () => {
  const [unit, nginx, main] = await Promise.all([
    asset('aipro-wechat-relay.service'), asset('nginx.conf.example'), asset('main.mjs'),
  ]);
  assert.match(unit, /^User=aipro-wechat-relay$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/aipro-wechat-relay$/m);
  assert.match(unit, /^Environment=RELAY_CONFIG_PATH=\/etc\/aipro-wechat-relay\/config\.json$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(nginx, /server_name wxrelay\.e2eskill\.cn;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:17658;/);
  assert.doesNotMatch(nginx, /4000|www\.e2eskill\.cn|zhenyuskill\.com/);
  assert.match(main, /'127\.0\.0\.1'/);
  assert.doesNotMatch(unit + nginx + main, /callback-secret-123|relay-token-123|artifact-token-123/);
});

test('deployment documentation requires a rollback and renewal gate', async () => {
  const instructions = await asset('README.md');
  assert.match(instructions, /续费/);
  assert.match(instructions, /回滚/);
  assert.match(instructions, /nginx -t/);
  assert.match(instructions, /SQLite/);
});

test('staged package preserves relative contract import path', async () => {
  const [unit, script, server] = await Promise.all([
    asset('aipro-wechat-relay.service'), asset('deploy.sh'), asset('server.mjs'),
  ]);
  assert.match(server, /from '\.\.\/worker\/src\/contract\.mjs'/);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/aipro-wechat-relay\/aliyun\/main\.mjs/);
  assert.match(script, /\/opt\/aipro-wechat-relay\/aliyun\//);
  assert.match(script, /\/opt\/aipro-wechat-relay\/worker\/src\/contract\.mjs/);
});
