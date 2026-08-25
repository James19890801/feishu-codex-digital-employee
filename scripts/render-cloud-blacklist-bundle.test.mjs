import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderCloudBlacklistBundle } from './render-cloud-blacklist-bundle.mjs';

const dir = await mkdtemp(join(tmpdir(), 'aipros-cloud-blacklist-'));
const configPath = join(dir, 'config.json');
const outputPath = join(dir, 'bundle.json');
await writeFile(configPath, JSON.stringify({
  automaticCommunicationBlocklist: [
    { channel: 'dingtalk', displayName: 'A', openId: 'open-private-a', userId: 'staff-private-a' },
    { channel: 'dingtalk', displayName: 'B', openId: 'open-private-b', userId: 'staff-private-b' },
    { channel: 'feishu', displayName: 'C', openId: 'ignored-private' },
  ],
}));

const summary = await renderCloudBlacklistBundle({ configPath, outputPath });
assert.deepEqual(Object.keys(summary).sort(), ['digest', 'ok', 'senderCount', 'sourceEntryCount']);
assert.equal(summary.ok, true);
assert.equal(summary.sourceEntryCount, 2);
assert.equal(summary.senderCount, 4);
assert.match(summary.digest, /^[a-f0-9]{64}$/);
assert.equal((await stat(outputPath)).mode & 0o777, 0o600);

const bundleText = await readFile(outputPath, 'utf8');
const bundle = JSON.parse(bundleText);
assert.equal(bundle.AIPROS_ACCESS_MODE, 'blacklist');
assert.equal(bundle.AIPROS_BLOCKED_SENDER_IDS, 'open-private-a,open-private-b,staff-private-a,staff-private-b');
assert.equal(bundle.AIPROS_BLOCKED_CHAT_IDS, '');
assert.equal(bundle.sourceEntryCount, 2);
assert.equal(bundle.senderCount, 4);
assert.equal(bundle.digest, summary.digest);
assert.doesNotMatch(JSON.stringify(summary), /private/);

console.log('RENDER_CLOUD_BLACKLIST_BUNDLE_TEST_OK');
