import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { uploadRelayArtifact } from './wechat-edge-artifact-bootstrap.mjs';

test('uploads a regular file and returns a callback-compatible public route', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-artifact-'));
  const filePath = path.join(directory, 'report.pdf');
  await writeFile(filePath, 'pdf-data');
  let request;
  const route = await uploadRelayArtifact({
    path: filePath,
    fileName: '季度报告.pdf',
    relayOrigin: 'https://relay.example',
    artifactToken: 'a'.repeat(32),
    tokenFactory: () => 'b'.repeat(32),
    fetchImpl: async (url, options) => {
      request = { url: String(url), options, body: await new Response(options.body).text() };
      return Response.json({
        ok: true,
        publicPath: '/webhooks/gewe/callback-secret-abcdefghijkl/artifacts/' + 'b'.repeat(32) + '/report.pdf',
      }, { status: 201 });
    },
  });
  assert.equal(route, '/webhooks/gewe/callback-secret-abcdefghijkl/artifacts/' + 'b'.repeat(32) + '/report.pdf');
  assert.match(request.url, /^https:\/\/relay\.example\/relay\/artifacts\//);
  assert.equal(request.options.method, 'PUT');
  assert.equal(request.body, 'pdf-data');
});

test('rejects an empty artifact before making a network request', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'relay-artifact-empty-'));
  const filePath = path.join(directory, 'empty.txt');
  await writeFile(filePath, '');
  await assert.rejects(() => uploadRelayArtifact({
    path: filePath,
    fileName: 'empty.txt',
    relayOrigin: 'https://relay.example',
    artifactToken: 'a'.repeat(32),
    fetchImpl: async () => { throw new Error('must not fetch'); },
  }), /size is invalid/);
});
