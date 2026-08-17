import assert from 'node:assert/strict';
import {
  fetchEnterpriseChatLegacyBridgeWindow,
  semanticObserverFailureRecord,
  shouldRunEnterpriseChatSemanticObserver,
} from './enterpriseChat-legacyBridge-poller.mjs';

assert.equal(shouldRunEnterpriseChatSemanticObserver({
  enterpriseChatEnabled: true,
  semanticGroupEngagementEnabled: true,
  enterpriseChatTransport: 'event-stream',
}), false);
assert.equal(shouldRunEnterpriseChatSemanticObserver({
  enterpriseChatEnabled: true,
  semanticGroupEngagementEnabled: true,
  enterpriseChatTransport: 'legacyBridge-polling',
}), false);
assert.deepEqual(semanticObserverFailureRecord(new Error('rate limited'), {
  failures: 2,
  delayMs: 30000,
  at: '2026-08-08T12:00:00.000Z',
}), {
  at: '2026-08-08T12:00:00.000Z',
  failures: 2,
  delayMs: 30000,
  error: 'rate limited',
});
assert.equal('connected' in semanticObserverFailureRecord(new Error('x')), false);

const calls = [];
const pages = [{
  success: true,
  result: {
    conversationMessagesList: [{
      openConversationId: 'cid-direct',
      singleChat: true,
      title: '同事甲',
      messages: [{
        content: '第一页消息',
        createTime: '2026-08-03 11:21:00',
        openConversationId: 'cid-direct',
        openMessageId: 'msg-page-1',
        sender: '同事甲',
        senderEnterpriseUserId: 'open-colleague',
      }],
    }],
    hasMore: true,
    nextCursor: 'cursor-page-2',
  },
}, {
  success: true,
  result: {
    conversationMessagesList: [{
      openConversationId: 'cid-group',
      singleChat: false,
      title: '研发群',
      messages: [{
        content: '@阿充 第二页消息',
        createTime: '2026-08-03 11:22:00',
        openConversationId: 'cid-group',
        openMessageId: 'msg-page-2',
        sender: '同事乙',
        senderEnterpriseUserId: 'open-colleague-2',
      }, {
        content: 'AI 对流程管理有什么影响？',
        createTime: '2026-08-03 11:22:01',
        openConversationId: 'cid-group',
        openMessageId: 'msg-page-semantic',
        sender: '同事丙',
        senderEnterpriseUserId: 'open-colleague-3',
      }],
    }],
    hasMore: false,
    nextCursor: 'finished',
  },
}];

const payloads = await fetchEnterpriseChatLegacyBridgeWindow({
  bin: '/opt/legacyBridge/connector',
  start: '2026-08-03 11:20:00',
  end: '2026-08-03 11:25:00',
  ownerOpenId: 'open-owner',
  ownerNames: ['阿充', '阿充James'],
  mentionNames: ['阿充', '阿充James'],
  includeUnmentionedGroups: true,
  run: async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: JSON.stringify(pages[calls.length - 1]), stderr: '' };
  },
  runOptions: { cwd: '/srv/aipro', timeoutMs: 45_000 },
});

assert.deepEqual(payloads.map(item => item.message.message_id), [
  'enterpriseChat:msg-page-1',
  'enterpriseChat:msg-page-2',
  'enterpriseChat:msg-page-semantic',
]);
assert.equal(payloads[2].metadata.semanticCandidate, true);
assert.equal(calls.length, 2);
assert.equal(calls[0].bin, '/opt/legacyBridge/connector');
assert.equal(calls[0].args[calls[0].args.indexOf('--cursor') + 1], '0');
assert.equal(calls[1].args[calls[1].args.indexOf('--cursor') + 1], 'cursor-page-2');
assert.deepEqual(calls[1].options, { cwd: '/srv/aipro', timeoutMs: 45_000 });

await assert.rejects(
  fetchEnterpriseChatLegacyBridgeWindow({
    bin: '/opt/legacyBridge/connector',
    start: '2026-08-03 11:20:00',
    end: '2026-08-03 11:25:00',
    ownerOpenId: 'open-owner',
    run: async () => ({
      stdout: JSON.stringify({ success: false, error: { message: 'auth expired' } }),
      stderr: '',
    }),
  }),
  /auth expired/,
);

console.log('ENTERPRISE_CHAT_LEGACY_BRIDGE_POLLER_TEST_OK');
