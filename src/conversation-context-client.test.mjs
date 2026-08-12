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
    bin: PORTABLE_DWS_BIN,
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
  bin: PORTABLE_DWS_BIN,
  profile: 'corp:user',
  transport: 'event-stream',
  env: {},
  cwd: '/srv/james',
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
  conversationId = 'dingtalk:user:cross-org-user',
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

function historySuccessPayload({
  messageId = 'cross-org-current',
  conversationId = 'provider-cross-org-conversation',
  senderId = 'cross-org-user',
  content = '跨组织问题',
} = {}) {
  return {
    success: true,
    result: {
      messages: [{
        openMessageId: messageId,
        openConversationId: conversationId,
        senderOpenDingTalkId: senderId,
        sender: '外部同事',
        content,
        createTime: '2026-08-11 17:00:00',
      }],
    },
  };
}

{
  const calls = [];
  const channelEnv = { DWS_CHANNEL: 'digital-human-channel', LANG: 'zh_CN.UTF-8' };
  let historyReads = 0;
  const crossOrgClient = new ConversationContextClient({
    bin: PORTABLE_DWS_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: channelEnv,
    cwd: '/srv/james',
    ownerIds: ['owner-open'],
    runner: async (bin, args, options) => {
      calls.push({ bin, args, options });
      if (args[0] === 'chat' && args[1] === 'data-auth') {
        return { stdout: JSON.stringify({ success: true, result: { granted: true } }) };
      }
      historyReads += 1;
      return {
        stdout: JSON.stringify(historyReads === 1
          ? crossOrgDeniedPayload()
          : historySuccessPayload()),
      };
    },
  });

  const result = await crossOrgClient.fetch(historyContext());
  assert.equal(result.latestCounterpartyMessage.content, '跨组织问题');
  assert.deepEqual(calls.map(call => call.args.slice(0, 4)), [
    ['chat', 'message', 'list', '--open-dingtalk-id'],
    ['chat', 'data-auth', 'cross-org', '--all'],
    ['chat', 'message', 'list', '--open-dingtalk-id'],
  ]);
  assert.deepEqual(calls[1].args, [
    'chat', 'data-auth', 'cross-org', '--all',
    '--grant-type', 'timed', '--ttl', '24h',
    '--format', 'json', '--profile', 'corp:user', '-y',
  ]);
  for (const call of calls) assert.deepEqual(call.options.env, channelEnv);
}

{
  const calls = [];
  const unrelatedErrorClient = new ConversationContextClient({
    bin: PORTABLE_DWS_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: { DWS_CHANNEL: 'digital-human-channel' },
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

{
  const calls = [];
  const failedGrantClient = new ConversationContextClient({
    bin: PORTABLE_DWS_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: { DWS_CHANNEL: 'digital-human-channel' },
    cwd: '/srv/james',
    ownerIds: ['owner-open'],
    runner: async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify(args[1] === 'data-auth'
          ? { success: false, error: { code: 'GrantDenied', message: 'grant rejected' } }
          : crossOrgDeniedPayload()),
      };
    },
  });

  await assert.rejects(failedGrantClient.fetch(historyContext()), /grant rejected/i);
  assert.deepEqual(calls.map(call => call.args[1]), ['message', 'data-auth']);
}

{
  const readsByTarget = new Map();
  let grantCalls = 0;
  let releaseGrant;
  const grantBarrier = new Promise(resolve => { releaseGrant = resolve; });
  const concurrentClient = new ConversationContextClient({
    bin: PORTABLE_DWS_BIN,
    profile: 'corp:user',
    transport: 'event-stream',
    env: { DWS_CHANNEL: 'digital-human-channel' },
    cwd: '/srv/james',
    ownerIds: ['owner-open'],
    runner: async (bin, args) => {
      if (args[1] === 'data-auth') {
        grantCalls += 1;
        await grantBarrier;
        return { stdout: JSON.stringify({ success: true }) };
      }
      const targetId = args[4];
      const reads = (readsByTarget.get(targetId) || 0) + 1;
      readsByTarget.set(targetId, reads);
      return {
        stdout: JSON.stringify(reads === 1
          ? crossOrgDeniedPayload()
          : historySuccessPayload({
              messageId: `${targetId}-message`,
              senderId: targetId,
              content: `来自 ${targetId} 的问题`,
            })),
      };
    },
  });

  const first = concurrentClient.fetch(historyContext({
    messageId: 'external-a-message',
    conversationId: 'dingtalk:user:external-a',
    senderId: 'external-a',
    content: '来自 external-a 的问题',
  }));
  const second = concurrentClient.fetch(historyContext({
    messageId: 'external-b-message',
    conversationId: 'dingtalk:user:external-b',
    senderId: 'external-b',
    content: '来自 external-b 的问题',
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(grantCalls, 1);
  releaseGrant();
  const results = await Promise.all([first, second]);
  assert.deepEqual(
    results.map(result => result.latestCounterpartyMessage.content),
    ['来自 external-a 的问题', '来自 external-b 的问题'],
  );
  assert.equal(grantCalls, 1);
  assert.deepEqual([...readsByTarget.values()], [2, 2]);
}

console.log('CONVERSATION_CONTEXT_CLIENT_TEST_OK');
