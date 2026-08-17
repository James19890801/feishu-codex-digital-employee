import assert from 'node:assert/strict';
import {
  ConversationContextClient,
  ConversationHistoryError,
  isSupportedConnectorExecutable,
} from './conversation-context-client.mjs';

const PORTABLE_CONNECTOR_BIN = '/opt/homebrew/bin/connector';

assert.equal(isSupportedConnectorExecutable(PORTABLE_CONNECTOR_BIN), true);
assert.equal(isSupportedConnectorExecutable('/usr/local/bin/connector'), true);
assert.equal(isSupportedConnectorExecutable('connector'), false);
assert.equal(isSupportedConnectorExecutable('/opt/legacyBridge/bin/connector'), false);
assert.equal(isSupportedConnectorExecutable('/tmp/.real/.bin/connector/bin/connector'), false);

const successPayload = {
  success: true,
  result: {
    messages: [{
      openMessageId: 'msg-1',
      openConversationId: 'cid-direct',
      senderEnterpriseUserId: 'colleague-open',
      sender: '同事甲',
      content: '最后一句',
      createTime: '2026-08-03 15:00:00',
      quotedMessage: null,
      openConvThreadId: '',
    }],
  },
};

const audits = [];
const client = new ConversationContextClient({
  bin: PORTABLE_CONNECTOR_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: { CONNECTOR_CHANNEL: 'channel-1' },
  cwd: '/srv/james',
  ownerIds: ['owner-open'],
  runner: async () => ({ stdout: JSON.stringify(successPayload), stderr: '', exitCode: 0 }),
  timeoutMs: 30_000,
  audit: (event, detail) => audits.push({ event, detail }),
});

const fetched = await client.fetch({
  kind: 'direct',
  targetId: 'colleague-open',
  beforeTime: '2026-08-03 15:00:01',
  conversationId: 'cid-direct',
  currentMessage: {
    messageId: 'msg-1', conversationId: 'cid-direct', senderId: 'colleague-open',
    senderName: '同事甲', content: '最后一句', createdAt: '2026-08-03 15:00:00',
  },
});

assert.equal(fetched.messages.length, 1);
assert.equal(fetched.latestCounterpartyMessage.content, '最后一句');
assert.equal(audits.length, 1);
assert.equal(audits[0].event, 'conversation_history_read');
assert.deepEqual(Object.keys(audits[0].detail).sort(), ['durationMs', 'messageCount', 'styleSampleCount']);
assert.doesNotMatch(JSON.stringify(audits), /最后一句/);

async function expectHistoryError(overrides, pattern, code = 'CONVERSATION_HISTORY_UNAVAILABLE') {
  const instance = new ConversationContextClient({
    bin: PORTABLE_CONNECTOR_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: {},
    cwd: '/srv/james',
    ownerIds: ['owner-open'],
    runner: async () => ({ stdout: JSON.stringify(successPayload), stderr: '', exitCode: 0 }),
    timeoutMs: 30_000,
    ...overrides,
  });
  await assert.rejects(
    instance.fetch({
      kind: 'direct', targetId: 'colleague-open', beforeTime: '2026-08-03 15:00:01',
      conversationId: 'cid-direct',
      currentMessage: {
        messageId: 'msg-1', conversationId: 'cid-direct', senderId: 'colleague-open',
        senderName: '同事甲', content: '最后一句', createdAt: '2026-08-03 15:00:00',
      },
    }),
    error => error instanceof ConversationHistoryError
      && error.code === code
      && pattern.test(error.message),
  );
}

await expectHistoryError(
  { bin: '/tmp/.real/.bin/connector/bin/connector' },
  /original CONNECTOR/i,
  'CONNECTOR_PATH_REJECTED',
);
await expectHistoryError(
  { transport: 'legacyBridge-polling' },
  /event-stream/i,
  'CONNECTOR_TRANSPORT_REJECTED',
);
await expectHistoryError(
  { runner: async () => ({ stdout: '<html>bad</html>', stderr: '', exitCode: 0 }) },
  /JSON/i,
);
await expectHistoryError(
  { runner: async () => ({ stdout: JSON.stringify({ success: false, error: { message: 'auth expired' } }), stderr: '', exitCode: 0 }) },
  /auth expired/i,
);
await expectHistoryError(
  { runner: async () => ({ stdout: JSON.stringify({ success: true, result: {} }), stderr: '', exitCode: 0 }) },
  /message list/i,
);
await expectHistoryError(
  { runner: async () => { throw new Error('process timeout after 30000ms'); } },
  /timeout/i,
);

const emptyClient = new ConversationContextClient({
  bin: PORTABLE_CONNECTOR_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: {},
  cwd: '/srv/james',
  ownerIds: ['owner-open'],
  runner: async () => ({ stdout: JSON.stringify({ success: true, result: { messages: [] } }), stderr: '', exitCode: 0 }),
});
const firstConversation = await emptyClient.fetch({
  kind: 'direct', targetId: 'colleague-open', beforeTime: '2026-08-03 15:00:01',
  conversationId: 'cid-direct',
  currentMessage: {
    messageId: 'first-1', conversationId: 'cid-direct', senderId: 'colleague-open',
    senderName: '同事甲', content: '第一次说话', createdAt: '2026-08-03 15:00:00',
  },
});
assert.equal(firstConversation.messages.length, 1);
assert.equal(firstConversation.latestCounterpartyMessage.content, '第一次说话');

const verifiedDisplayNameClient = new ConversationContextClient({
  bin: PORTABLE_CONNECTOR_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: {},
  cwd: '/srv/james',
  ownerIds: ['owner-demo'],
  ownerNames: ['新用户', '小新'],
  runner: async () => ({
    stdout: JSON.stringify({
      success: true,
      result: {
        messages: [{
          openMessageId: 'owner-display-1', openConversationId: 'provider-cid',
          senderEnterpriseUserId: 'owner-open-unknown', sender: '小新',
          content: '这个我先看下', createTime: '2026-08-03 14:59:00',
        }],
      },
    }),
    stderr: '',
    exitCode: 0,
  }),
});
const verifiedDisplayName = await verifiedDisplayNameClient.fetch({
  kind: 'direct', targetId: 'colleague-open', beforeTime: '2026-08-03 15:00:01',
  conversationId: 'enterpriseChat:user:colleague-open',
  currentMessage: {
    messageId: 'owner-display-current', conversationId: 'enterpriseChat:user:colleague-open',
    senderId: 'colleague-open', senderName: '同事甲', content: '你看看这个',
    createdAt: '2026-08-03 15:00:00',
  },
});
assert.equal(verifiedDisplayName.styleSamples.length, 1);
assert.equal(verifiedDisplayName.styleSamples[0].content, '这个我先看下');

function crossOrgDeniedPayload() {
  return {
    success: false,
    error: {
      code: 'CrossOrgPermissionDenied',
      message: 'Cross-organization chat data permission is required',
    },
  };
}

function historyContext({
  messageId = 'cross-org-current',
  conversationId = 'enterpriseChat:user:cross-org-user',
  senderId = 'cross-org-user',
  content = '跨组织问题',
} = {}) {
  return {
    kind: 'direct',
    targetId: senderId,
    beforeTime: '2026-08-11 17:00:01',
    conversationId,
    currentMessage: {
      messageId,
      conversationId,
      senderId,
      senderName: '外部同事',
      content,
      createdAt: '2026-08-11 17:00:00',
    },
  };
}

{
  const calls = [];
  const channelEnv = { CONNECTOR_CHANNEL: 'digital-human-channel', LANG: 'zh_CN.UTF-8' };
  const crossOrgClient = new ConversationContextClient({
    bin: PORTABLE_CONNECTOR_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: channelEnv,
    cwd: '/srv/james',
    ownerIds: ['owner-open'],
    runner: async (bin, args, options) => {
      calls.push({ bin, args, options });
      return { stdout: JSON.stringify(crossOrgDeniedPayload()) };
    },
  });

  await assert.rejects(
    crossOrgClient.fetch(historyContext()),
    error => error?.code === 'CONVERSATION_HISTORY_UNAVAILABLE'
      && /Cross-organization chat data permission is required/.test(error.message),
  );
  assert.equal(calls.length, 1, 'history denial must never trigger a data authorization write');
  assert.deepEqual(calls[0].args.slice(0, 4), [
    'chat', 'message', 'list', '--user',
  ]);
  assert.deepEqual(calls[0].options.env, channelEnv);
}

{
  const calls = [];
  const unrelatedErrorClient = new ConversationContextClient({
    bin: PORTABLE_CONNECTOR_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: { CONNECTOR_CHANNEL: 'digital-human-channel' },
    cwd: '/srv/james',
    ownerIds: ['owner-open'],
    runner: async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({
          success: false,
          error: { code: 'AuthenticationExpired', message: 'auth expired' },
        }),
      };
    },
  });

  await assert.rejects(unrelatedErrorClient.fetch(historyContext()), /auth expired/i);
  assert.equal(calls.length, 1);
}

console.log('CONVERSATION_CONTEXT_CLIENT_TEST_OK');
