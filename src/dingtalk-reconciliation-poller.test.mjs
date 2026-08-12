import assert from 'node:assert/strict';
import { fetchDingTalkReconciliationWindow } from './dingtalk-reconciliation-poller.mjs';

const calls = [];
const pages = [{
  success: true,
  result: {
    conversationMessagesList: [{
      openConversationId: 'cid-direct',
      singleChat: true,
      title: '同事甲',
      messages: [{
        content: '事件流漏掉的消息',
        createTime: '2026-08-12 16:30:51',
        openConversationId: 'cid-direct',
        openMessageId: 'msg-missed-1',
        sender: '同事甲',
        senderOpenDingTalkId: 'open-colleague',
      }],
    }],
    hasMore: true,
    nextCursor: 'cursor-2',
  },
}, {
  success: true,
  result: {
    conversationMessagesList: [{
      openConversationId: 'cid-direct-2',
      singleChat: true,
      title: '同事乙',
      messages: [{
        content: '第二页漏掉的消息',
        createTime: '2026-08-12 16:31:00',
        openConversationId: 'cid-direct-2',
        openMessageId: 'msg-missed-2',
        sender: '同事乙',
        senderOpenDingTalkId: 'open-colleague-2',
      }],
    }],
    hasMore: false,
    nextCursor: 'done',
  },
}];

const payloads = await fetchDingTalkReconciliationWindow({
  bin: '/opt/dws',
  profile: 'profile:open-owner',
  start: '2026-08-12 16:25:00',
  end: '2026-08-12 16:35:00',
  ownerOpenId: 'open-owner',
  ownerNames: ['阿充James'],
  run: async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: JSON.stringify(pages[calls.length - 1]), stderr: '' };
  },
  runOptions: { cwd: '/srv/james' },
});

assert.deepEqual(payloads.map(item => item.message.message_id), [
  'dingtalk:msg-missed-1',
  'dingtalk:msg-missed-2',
]);
assert.equal(payloads.every(item => item.metadata.source === 'event-stream-reconciliation'), true);
assert.deepEqual(calls[0].args.slice(0, 2), ['--profile', 'profile:open-owner']);
assert.equal(calls[0].args[calls[0].args.indexOf('--cursor') + 1], '0');
assert.equal(calls[1].args[calls[1].args.indexOf('--cursor') + 1], 'cursor-2');

await assert.rejects(
  fetchDingTalkReconciliationWindow({
    bin: '/opt/dws',
    profile: 'profile:open-owner',
    start: '2026-08-12 16:25:00',
    end: '2026-08-12 16:35:00',
    ownerOpenId: 'open-owner',
    run: async () => ({
      stdout: JSON.stringify({ success: false, error: { message: 'temporary failure' } }),
      stderr: '',
    }),
  }),
  /temporary failure/,
);

console.log('DINGTALK_RECONCILIATION_POLLER_TEST_OK');
