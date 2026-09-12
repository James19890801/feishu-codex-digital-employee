import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildParityManifest } from './cloud-parity-manifest.mjs';
import { CloudParitySync } from './cloud-parity-sync.mjs';

test('daily reconciliation uploads changed manifest with the next server sequence', async () => {
  const manifest = buildParityManifest({ persona: 'current', config: { allowAllChats: false } });
  const calls = [];
  const client = new CloudParitySync({ baseUrl: 'https://relay.test', token: 'test-token',
    workerId: 'mac', manifestSource: async () => manifest,
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith('/parity/status?workerId=mac')) return new Response(JSON.stringify({
        ok: true, digest: 'old', workerSequence: 7,
      }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, revision: 8, digest: manifest.digest }), { status: 200 });
    } });
  assert.deepEqual(await client.reconcile(), { changed: true, revision: 8, digest: manifest.digest });
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1][1].body).sequence, 8);
  assert.equal(calls[1][1].headers.authorization, 'Bearer test-token');
});

test('matching digest performs no upload', async () => {
  const manifest = buildParityManifest({ persona: 'unchanged' });
  let calls = 0;
  const client = new CloudParitySync({ baseUrl: 'https://relay.test', token: 'test-token',
    workerId: 'mac', manifestSource: async () => manifest,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, revision: 4,
        digest: manifest.digest, workerSequence: 4 }), { status: 200 });
    } });
  assert.deepEqual(await client.reconcile(), { changed: false, revision: 4, digest: manifest.digest });
  assert.equal(calls, 1);
});

test('requires HTTPS and refuses to treat failed upload as synced', async () => {
  assert.throws(() => new CloudParitySync({ baseUrl: 'http://relay.test', token: 'x',
    manifestSource: async () => ({}) }), /https/i);
  const manifest = buildParityManifest({ persona: 'current' });
  let call = 0;
  const client = new CloudParitySync({ baseUrl: 'https://relay.test', token: 'test-token',
    workerId: 'mac', manifestSource: async () => manifest, fetchImpl: async () => {
      call += 1;
      return call === 1
        ? new Response(JSON.stringify({ ok: true, digest: null, workerSequence: 0 }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error: 'policy_conflict' }), { status: 409 });
    } });
  await assert.rejects(client.reconcile(), /policy_conflict/);
});
