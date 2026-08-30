import assert from 'node:assert/strict';
import { decideWeChatGroupReplyPolicy } from './wechat-group-reply-policy.mjs';

const base = {
  channel: 'wechat',
  chatType: 'group',
  aliases: ['小詹', '数字人', 'AIPRO'],
};

for (const text of [
  '小詹回复一下',
  '麻烦数字人点评一下这篇',
  '这篇请小詹帮忙看看',
  '让小詹说两句',
  'AIPRO 能不能分析下？',
]) {
  assert.deepEqual(decideWeChatGroupReplyPolicy({ ...base, text }), {
    applies: true,
    shouldReply: true,
    reasonCode: 'direct_alias_request',
    responseRequired: true,
  }, text);
}

for (const text of [
  'https://example.com/article',
  '大家觉得这篇文章怎么样？ https://example.com/article',
  '小詹今天也在群里',
  '这是小詹上次分享的内容',
  '这个问题谁能回答？',
  '',
]) {
  assert.deepEqual(decideWeChatGroupReplyPolicy({ ...base, text }), {
    applies: true,
    shouldReply: false,
    reasonCode: 'passive_group_context',
    responseRequired: false,
  }, text);
}

assert.deepEqual(decideWeChatGroupReplyPolicy({
  ...base,
  text: '@小詹 请看看这个链接',
  explicitMention: true,
}), {
  applies: true,
  shouldReply: true,
  reasonCode: 'explicit_mention',
  responseRequired: true,
});

for (const input of [
  { channel: 'dingtalk', chatType: 'group', text: '小詹回复一下' },
  { channel: 'wechat', chatType: 'p2p', text: 'https://example.com/article' },
]) {
  assert.deepEqual(decideWeChatGroupReplyPolicy({ ...base, ...input }), {
    applies: false,
    shouldReply: false,
    reasonCode: 'not_wechat_group',
    responseRequired: false,
  });
}

console.log('WECHAT_GROUP_REPLY_POLICY_TEST_OK');
