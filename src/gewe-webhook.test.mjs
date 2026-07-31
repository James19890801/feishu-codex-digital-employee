import assert from 'node:assert/strict';
import { GeWeWebhookServer } from './im-channel-runtime.mjs';

const received = [];
const statuses = [];
const secret = 'callback_secret_1234567890123456';
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
} finally {
  await server.stop();
}
assert.equal(statuses.at(-1).callbackListening, false);

assert.throws(() => new GeWeWebhookServer({
  channel,
  callbackSecret: 'short',
  port: 17656,
}), /callback secret/i);

console.log('GEWE_WEBHOOK_TEST_OK');
