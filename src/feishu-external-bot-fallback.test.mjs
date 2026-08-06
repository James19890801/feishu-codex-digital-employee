import assert from 'node:assert/strict';

let fallback;
try {
  fallback = await import('./feishu-external-bot-fallback.mjs');
} catch {}

assert.equal(typeof fallback?.isExternalChatApiRestriction, 'function');
assert.equal(typeof fallback?.sendFeishuTextWithExternalBotFallback, 'function');
assert.equal(typeof fallback?.resolveFeishuChatType, 'function');
assert.equal(typeof fallback?.isExpectedLarkCliResult, 'function');
assert.equal(typeof fallback?.shouldSendFeishuP2pAsBot, 'function');
assert.equal(typeof fallback?.discoverBotP2pChats, 'function');
assert.equal(fallback.shouldSendFeishuP2pAsBot({ chatType: 'p2p', botChat: true }), true);
assert.equal(fallback.shouldSendFeishuP2pAsBot({ chatType: 'p2p', botChat: false }), false);
assert.equal(fallback.shouldSendFeishuP2pAsBot({ chatType: 'group', botChat: true }), false);
assert.equal(fallback.isExpectedLarkCliResult({ ok: true, identity: 'bot' }, 'bot'), true);
assert.equal(fallback.isExpectedLarkCliResult({ ok: true, identity: 'bot' }, 'user'), false);
assert.equal(fallback.isExpectedLarkCliResult({ ok: false, identity: 'bot' }, 'bot'), false);
assert.equal(fallback.resolveFeishuChatType('group', 'p2p'), 'group');
assert.equal(fallback.resolveFeishuChatType('', 'group'), 'group');
assert.equal(fallback.resolveFeishuChatType('', 'invalid'), '');

const botDiscoveryFailure = await fallback.discoverBotP2pChats({
  messages: [{
    message_id: 'om_owner_normal_chat',
    chat_id: 'oc_owner_normal_chat',
    chat_type: 'p2p',
    sender: { id: 'ou_owner', sender_type: 'user' },
  }],
  ownerOpenId: 'ou_owner',
  readAsBot: async ids => {
    assert.deepEqual(ids, ['om_owner_normal_chat']);
    throw new Error('bot cannot read ordinary personal chat');
  },
});
assert.deepEqual([...botDiscoveryFailure.chatIds], []);
assert.match(botDiscoveryFailure.error, /cannot read ordinary personal chat/);

const botDiscoverySuccess = await fallback.discoverBotP2pChats({
  messages: [{
    message_id: 'om_bot_chat',
    chat_id: 'oc_bot_chat',
    chat_type: 'p2p',
    sender: { id: 'ou_owner', sender_type: 'user' },
  }, {
    message_id: 'om_other_sender',
    chat_id: 'oc_other',
    chat_type: 'p2p',
    sender: { id: 'ou_other', sender_type: 'user' },
  }],
  ownerOpenId: 'ou_owner',
  readAsBot: async ids => {
    assert.deepEqual(ids, ['om_bot_chat']);
    return { data: { messages: [{ message_id: 'om_bot_chat', chat_id: 'oc_bot_chat' }] } };
  },
});
assert.deepEqual([...botDiscoverySuccess.chatIds], ['oc_bot_chat']);
assert.equal(botDiscoverySuccess.error, '');

assert.equal(fallback.isExternalChatApiRestriction(new Error(
  '{"code":230027,"message":"access denied for this operation"}',
)), true);
const bufferedProcessError = new Error('process exited with code 3');
bufferedProcessError.code = 'PROCESS_EXIT';
bufferedProcessError.stderr = '{"ok":false,"error":{"code":230027,"message":"access denied"}}';
assert.equal(fallback.isExternalChatApiRestriction(bufferedProcessError), true);
assert.equal(fallback.isExternalChatApiRestriction(new Error(
  '{"code":230038,"message":"cross tenant p2p chat operate forbid"}',
)), false);

let userCalls = 0;
let botCalls = 0;
const groupResult = await fallback.sendFeishuTextWithExternalBotFallback({
  chatType: 'group',
  sendAsUser: async () => {
    userCalls += 1;
    throw new Error('{"code":230027,"message":"access denied"}');
  },
  sendAsBot: async () => {
    botCalls += 1;
    return { ok: true, identity: 'bot' };
  },
});
assert.equal(groupResult.identity, 'bot');
assert.equal(userCalls, 1);
assert.equal(botCalls, 1);

await assert.rejects(
  fallback.sendFeishuTextWithExternalBotFallback({
    chatType: 'p2p',
    sendAsUser: async () => { throw new Error('{"code":230027}'); },
    sendAsBot: async () => { throw new Error('bot must not run'); },
  }),
  /230027/,
);

await assert.rejects(
  fallback.sendFeishuTextWithExternalBotFallback({
    chatType: 'group',
    sendAsUser: async () => { throw new Error('{"code":999,"message":"network"}'); },
    sendAsBot: async () => { throw new Error('bot must not run'); },
  }),
  /network/,
);

console.log('FEISHU_EXTERNAL_BOT_FALLBACK_TEST_OK');
