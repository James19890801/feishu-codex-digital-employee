import assert from 'node:assert/strict';
import { QoderCloudClient, parseQoderSse, readQoderSse } from './qoder-client.mjs';

const calls = [];
let now = 1_000;
const client = new QoderCloudClient({
  pat: 'pat-test', agentId: 'agent-1', agentVersion: 7, environmentId: 'env-1',
  baseUrl: 'https://qoder.test', now: () => { now += 21; return now; }, delay: async () => {},
  fetchImpl: async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith('/sessions')) return Response.json({ id: 'sess-1' });
    if (url.endsWith('/events')) return Response.json({ data: [{ id: 'evt-user' }] });
    if (url.endsWith('/events/stream')) return new Response([
      'event: agent.message', 'data: {"text":"cloud "}', '',
      'event: agent.message', 'data: {"content":[{"text":"answer"}]}', '',
      'event: session.status_idle', 'data: {"turn_id":"turn-1"}', '',
    ].join('\n'), { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/archive')) return Response.json({ ok: true });
    throw new Error('unexpected URL');
  },
});
const output = await client.execute({ prompt: 'hello', digest: 'a'.repeat(64), metadata: { level: 'L0' } });
assert.equal(output.text, 'cloud answer');
assert.equal(output.sessionId, 'sess-1');
assert.deepEqual(calls[0].body, {
  agent: { id: 'agent-1', type: 'agent', version: 7 }, environment_id: 'env-1',
  metadata: { digest: 'a'.repeat(64), level: 'L0' },
});
assert.equal('tools' in calls[0].body, false);
assert.deepEqual(calls[1].body, {
  events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }],
});
assert.equal(calls[1].options.headers.accept, 'application/json');
assert.equal(calls[2].url.endsWith('/events/stream'), true);
assert.equal(calls[2].options.method, 'GET');
assert.match(calls[2].options.headers.accept, /text\/event-stream/);
assert.equal(calls.at(-1).url.endsWith('/archive'), true);

assert.throws(() => parseQoderSse('event: agent.message\ndata: {"text":"x"}\n\n'),
  error => error.code === 'qoder_stream_incomplete');

let streamCancelled = false;
const openStream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode([
      'event: agent.message', 'data: {"content":"still open"}', '',
      'event: session.status_idle', 'data: {"turn_id":"turn-open"}', '', '',
    ].join('\n')));
  },
  cancel() { streamCancelled = true; },
});
assert.equal(await readQoderSse(new Response(openStream), { timeoutMs: 100 }), 'still open');
assert.equal(streamCancelled, true);

const delays = [];
let retryCalls = 0;
const retryClient = new QoderCloudClient({
  pat: 'pat', agentId: 'agent', environmentId: 'env', baseUrl: 'https://qoder.test',
  delay: async ms => delays.push(ms),
  fetchImpl: async () => {
    retryCalls += 1;
    if (retryCalls < 4) return new Response('busy', { status: retryCalls === 1 ? 429 : 503 });
    return Response.json({ id: 'sess-retry' });
  },
});
const response = await retryClient.request('/sessions', { body: {} });
assert.equal((await response.json()).id, 'sess-retry');
assert.deepEqual(delays, [1_000, 2_000, 4_000]);

let badCalls = 0;
const badClient = new QoderCloudClient({
  pat: 'pat', agentId: 'agent', environmentId: 'env', baseUrl: 'https://qoder.test',
  delay: async () => {}, fetchImpl: async () => { badCalls += 1; return new Response('bad token SECRET', { status: 400 }); },
});
await assert.rejects(() => badClient.request('/sessions', { body: {} }), error => error.status === 400);
assert.equal(badCalls, 1);

const timeoutCalls = [];
const timeoutClient = new QoderCloudClient({
  pat: 'pat', agentId: 'agent', agentVersion: 2, environmentId: 'env',
  baseUrl: 'https://qoder.test', streamTimeoutMs: 30, delay: async () => {},
  fetchImpl: async (url, options) => {
    timeoutCalls.push({ url, options });
    if (url.endsWith('/sessions')) return Response.json({ id: 'sess-timeout' });
    if (url.endsWith('/events')) return Response.json({ ok: true });
    if (url.endsWith('/events/stream')) {
      let timer;
      return new Response(new ReadableStream({
        start(controller) {
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode(
            'event: heartbeat\ndata: {}\n\n',
          )), 5);
        },
        cancel() { clearInterval(timer); },
      }));
    }
    if (url.endsWith('/sessions/sess-timeout') && options.method === 'GET') {
      return Response.json({ status: 'idle' });
    }
    return Response.json({ ok: true });
  },
});
await assert.rejects(() => timeoutClient.execute({ prompt: 'hello', digest: 'b'.repeat(64) }),
  error => error.code === 'qoder_stream_timeout');
assert.equal(timeoutCalls.some(call => call.url.endsWith('/cancel')), true);
assert.equal(timeoutCalls.some(call => call.url.endsWith('/sessions/sess-timeout')
  && call.options.method === 'GET'), true);
assert.equal(timeoutCalls.at(-1).url.endsWith('/archive'), true);

console.log('QODER_CLIENT_TEST_OK');
