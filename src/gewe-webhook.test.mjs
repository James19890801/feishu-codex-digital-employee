import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeWeWebhookServer } from './im-channel-runtime.mjs';

const received = [];
const statuses = [];
const secret = 'callback_secret_1234567890123456';
let nowMs = 1_000;
const artifactDirectory = await mkdtemp(join(tmpdir(), 'gewe-artifact-route-'));
const artifactPath = join(artifactDirectory, 'private-report.pdf');
const artifactSymlinkPath = join(artifactDirectory, 'private-report-link.pdf');
await writeFile(artifactPath, new Uint8Array([37, 80, 68, 70, 45, 49]));
await symlink(artifactPath, artifactSymlinkPath);
const channel = {
  normalizeWebhook(event) {
    if (event.ignore) return null;
    return { message: { message_id: `wechat:${event.id}` } };
  },
};
const server = new GeWeWebhookServer({
  channel,
  callbackSecret: secret,
  port: 0,
  onMessage: payload => received.push(payload),
  onStatus: patch => statuses.push(patch),
  now: () => nowMs,
});

await server.start();
try {
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  const base = `http://127.0.0.1:${address.port}`;

  const wrongPath = await fetch(`${base}/webhooks/gewe/wrong-secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'wrong' }),
  });
  assert.equal(wrongPath.status, 404);

  const invalid = await fetch(`${base}/webhooks/gewe/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not-json',
  });
  assert.equal(invalid.status, 400);

  const accepted = await fetch(`${base}/webhooks/gewe/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'message-1' }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { ok: true, accepted: true });
  assert.equal(received.length, 1);
  assert.equal(received[0].message.message_id, 'wechat:message-1');

  const ignored = await fetch(`${base}/webhooks/gewe/${secret}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ignore: true }),
  });
  assert.equal(ignored.status, 202);
  assert.deepEqual(await ignored.json(), { ok: true, accepted: false });
  assert.equal(received.length, 1);
  assert.equal(statuses.at(-1).callbackListening, true);

  const artifactRoute = await server.registerArtifact({
    path: artifactPath,
    fileName: '报告.pdf',
    ttlMs: 1_000,
  });
  await assert.rejects(
    server.registerArtifact({
      path: artifactSymlinkPath,
      fileName: '报告.pdf',
      ttlMs: 1_000,
    }),
    /regular file/,
  );
  assert.match(artifactRoute, new RegExp(`^/webhooks/gewe/${secret}/artifacts/[A-Za-z0-9_-]{32,}/`));
  assert.equal(artifactRoute.includes(artifactDirectory), false);
  assert.equal(artifactRoute.includes('private-report.pdf'), false);

  const artifact = await fetch(`${base}${artifactRoute}`);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get('cache-control'), 'no-store');
  assert.equal(artifact.headers.get('content-length'), '6');
  assert.match(artifact.headers.get('content-disposition'), /^attachment;/);
  assert.deepEqual([...new Uint8Array(await artifact.arrayBuffer())], [37, 80, 68, 70, 45, 49]);

  const unknownArtifact = await fetch(`${base}/webhooks/gewe/${secret}/artifacts/unknown-token/report.pdf`);
  assert.equal(unknownArtifact.status, 404);
  nowMs += 1_001;
  const expiredArtifact = await fetch(`${base}${artifactRoute}`);
  assert.equal(expiredArtifact.status, 404);
} finally {
  await server.stop();
  await rm(artifactDirectory, { recursive: true, force: true });
}
assert.equal(statuses.at(-1).callbackListening, false);

assert.throws(() => new GeWeWebhookServer({
  channel,
  callbackSecret: 'short',
  port: 17656,
}), /callback secret/i);

console.log('GEWE_WEBHOOK_TEST_OK');
