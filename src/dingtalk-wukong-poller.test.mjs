import assert from 'node:assert/strict';
import { fetchDingTalkWukongWindow } from './dingtalk-wukong-poller.mjs';

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
        senderOpenDingTalkId: 'open-colleague',
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
        senderOpenDingTalkId: 'open-colleague-2',
      }],
    }],
    hasMore: false,
    nextCursor: 'finished',
  },
}];

const payloads = await fetchDingTalkWukongWindow({
  bin: '/opt/wukong/dws',
  start: '2026-08-03 11:20:00',
  end: '2026-08-03 11:25:00',
  ownerOpenId: 'open-owner',
  ownerNames: ['阿充', '阿充James'],
  mentionNames: ['阿充', '阿充James'],
  run: async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: JSON.stringify(pages[calls.length - 1]), stderr: '' };
  },
  runOptions: { cwd: '/srv/james', timeoutMs: 45_000 },
});

assert.deepEqual(payloads.map(item => item.message.message_id), [
  'dingtalk:msg-page-1',
  'dingtalk:msg-page-2',
]);
assert.equal(calls.length, 2);
assert.equal(calls[0].bin, '/opt/wukong/dws');
assert.equal(calls[0].args[calls[0].args.indexOf('--cursor') + 1], '0');
assert.equal(calls[1].args[calls[1].args.indexOf('--cursor') + 1], 'cursor-page-2');
assert.deepEqual(calls[1].options, { cwd: '/srv/james', timeoutMs: 45_000 });

await assert.rejects(
  fetchDingTalkWukongWindow({
    bin: '/opt/wukong/dws',
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

console.log('DINGTALK_WUKONG_POLLER_TEST_OK');
