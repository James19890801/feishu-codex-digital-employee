import assert from 'node:assert/strict';
import {
  ConversationContextClient,
  ConversationHistoryError,
  isSupportedDwsExecutable,
} from './conversation-context-client.mjs';

const PORTABLE_DWS_BIN = '/opt/homebrew/bin/dws';

assert.equal(isSupportedDwsExecutable(PORTABLE_DWS_BIN), true);
assert.equal(isSupportedDwsExecutable('/usr/local/bin/dws'), true);
assert.equal(isSupportedDwsExecutable('dws'), false);
assert.equal(isSupportedDwsExecutable('/opt/wukong/bin/dws'), false);
assert.equal(isSupportedDwsExecutable('/tmp/.real/.bin/dws/bin/dws'), false);

const successPayload = {
  success: true,
  result: {
    messages: [{
      openMessageId: 'msg-1',
      openConversationId: 'cid-direct',
      senderOpenDingTalkId: 'colleague-open',
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
  bin: PORTABLE_DWS_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: { DWS_CHANNEL: 'channel-1' },
  cwd: '/srv/aipro',
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
    bin: PORTABLE_DWS_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: {},
    cwd: '/srv/aipro',
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
  { bin: '/tmp/.real/.bin/dws/bin/dws' },
  /original DWS/i,
  'DWS_PATH_REJECTED',
);
await expectHistoryError(
  { transport: 'wukong-polling' },
  /event-stream/i,
  'DWS_TRANSPORT_REJECTED',
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
  bin: PORTABLE_DWS_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: {},
  cwd: '/srv/aipro',
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
  bin: PORTABLE_DWS_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: {},
  cwd: '/srv/aipro',
  ownerIds: ['384351'],
  ownerNames: ['新用户', '小新'],
  runner: async () => ({
    stdout: JSON.stringify({
      success: true,
      result: {
        messages: [{
          openMessageId: 'owner-display-1', openConversationId: 'provider-cid',
          senderOpenDingTalkId: 'owner-open-unknown', sender: '小新',
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
  conversationId: 'dingtalk:user:colleague-open',
  currentMessage: {
    messageId: 'owner-display-current', conversationId: 'dingtalk:user:colleague-open',
    senderId: 'colleague-open', senderName: '同事甲', content: '你看看这个',
    createdAt: '2026-08-03 15:00:00',
  },
});
assert.equal(verifiedDisplayName.styleSamples.length, 1);
assert.equal(verifiedDisplayName.styleSamples[0].content, '这个我先看下');

console.log('CONVERSATION_CONTEXT_CLIENT_TEST_OK');
