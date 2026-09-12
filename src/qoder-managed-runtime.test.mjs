import assert from 'node:assert/strict';
import test from 'node:test';
import { QoderManagedRuntime } from './qoder-managed-runtime.mjs';

const BASE = 'https://api.qoder.com.cn/api/v1/cloud';
const agentId = 'agent_test';
const environmentId = 'env_test';

function sse(...events) {
  return new Response(events.map(([id, type, data]) =>
    `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
}

function mockFetch({ stream, statuses = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const route = new URL(url).pathname;
    if (statuses.length) return new Response('temporary', { status: statuses.shift() });
    if (route.endsWith('/sessions') && options.method === 'POST') {
      return Response.json({ id: 'session_test' });
    }
    if (route.endsWith('/events') && options.method === 'POST') return Response.json({ ok: true });
    if (route.endsWith('/events/stream')) return stream || sse(
      ['1', 'agent.message', { content: [{ type: 'text', text: '你好' }] }],
      ['2', 'session.status_idle', {}],
    );
    if (route.endsWith('/archive')) return Response.json({ ok: true });
    throw new Error(`unexpected route: ${route}`);
  };
  return { fetchImpl, calls };
}

function runtime(fetchImpl, extras = {}) {
  return new QoderManagedRuntime({ agentId, environmentId, agentVersion: 2,
    patSupplier: async () => 'test-pat', fetchImpl, delay: async () => {}, ...extras });
}

test('creates pinned managed session, sends scoped message, returns final answer and archives', async () => {
  const { fetchImpl, calls } = mockFetch();
  const result = await runtime(fetchImpl).execute({
    message: '请回答', policyDigest: 'a'.repeat(64), context: { persona: '小詹', thread: 'safe' },
  });
  assert.equal(result.text, '你好');
  assert.equal(result.sessionId, 'session_test');
  assert.equal(calls[0].url, `${BASE}/sessions`);
  const create = JSON.parse(calls[0].options.body);
  assert.deepEqual(create.agent, { id: agentId, type: 'agent', version: 2 });
  assert.equal(create.environment_id, environmentId);
  const event = JSON.parse(calls[1].options.body).events[0];
  assert.equal(event.type, 'user.message');
  assert.match(event.content[0].text, /请回答/);
  assert.equal(calls.at(-1).url, `${BASE}/sessions/session_test/archive`);
  assert.ok(calls.every(call => call.options.headers.authorization === 'Bearer test-pat'));
  assert.doesNotMatch(JSON.stringify(calls.map(call => call.options.body)), /test-pat/);
});

test('rejects credentials, raw DB and unapproved context keys before any request', async () => {
  const { fetchImpl, calls } = mockFetch();
  for (const context of [
    { token: 'secret' }, { database: 'raw' }, { persona: 'ok', localPath: '/private/a' },
  ]) {
    await assert.rejects(runtime(fetchImpl).execute({ message: 'x', policyDigest: 'a'.repeat(64), context }),
      /context|secret|unsupported/i);
  }
  assert.equal(calls.length, 0);
});

test('fails closed on custom tool request and never treats partial message as final', async () => {
  const { fetchImpl, calls } = mockFetch({ stream: sse(
    ['1', 'agent.message', { text: 'partial' }],
    ['2', 'agent.custom_tool_use', { tool_name: 'send_wechat' }],
    ['3', 'session.status_idle', {}],
  ) });
  await assert.rejects(runtime(fetchImpl).execute({ message: 'x', policyDigest: 'a'.repeat(64) }),
    error => error.code === 'qoder_tool_not_authorized');
  assert.ok(calls.some(call => call.url.endsWith('/archive')));
  assert.ok(!calls.some(call => call.url.includes('tool-results')));
});

test('resumes interrupted SSE with Last-Event-ID and deduplicates replayed events', async () => {
  const { fetchImpl, calls } = mockFetch();
  let streamCalls = 0;
  const reconnectingFetch = async (url, options) => {
    if (url.endsWith('/events/stream')) {
      streamCalls += 1;
      if (streamCalls === 1) return sse(['1', 'agent.message', { text: '你' }]);
      assert.equal(options.headers['Last-Event-ID'], '1');
      return sse(['1', 'agent.message', { text: '你' }],
        ['2', 'agent.message', { text: '好' }], ['3', 'session.status_idle', {}]);
    }
    return fetchImpl(url, options);
  };
  const result = await runtime(reconnectingFetch).execute({ message: 'x', policyDigest: 'a'.repeat(64) });
  assert.equal(result.text, '你好');
  assert.equal(streamCalls, 2);
  assert.ok(calls.some(call => call.url.endsWith('/archive')));
});

test('returns on session.status_idle even when the SSE connection stays open', async () => {
  const openStream = new ReadableStream({ start(value) {
    value.enqueue(new TextEncoder().encode('id: 1\nevent: agent.message\ndata: {"text":"OK"}\n\n'
      + 'id: 2\nevent: session.status_idle\ndata: {}\n\n'));
    setTimeout(() => { try { value.close(); } catch {} }, 200);
  } });
  const { fetchImpl } = mockFetch({ stream: new Response(openStream) });
  const startedAt = Date.now();
  const answer = await runtime(fetchImpl, { timeoutMs: 100 }).execute({
    message: 'x', policyDigest: 'a'.repeat(64),
  });
  assert.equal(answer.text, 'OK');
  assert.ok(Date.now() - startedAt < 100, 'idle event should complete before stream closes');
});

test('retries 429 and 5xx but fails closed on 4xx', async () => {
  const retry = mockFetch({ statuses: [429, 503] });
  assert.equal((await runtime(retry.fetchImpl).execute({ message: 'x', policyDigest: 'a'.repeat(64) })).text, '你好');
  assert.equal(retry.calls.length, 6);
  const denied = mockFetch({ statuses: [401] });
  await assert.rejects(runtime(denied.fetchImpl).execute({ message: 'x', policyDigest: 'a'.repeat(64) }),
    error => error.status === 401);
  assert.equal(denied.calls.length, 1);
});
