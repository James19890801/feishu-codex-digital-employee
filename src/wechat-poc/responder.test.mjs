import assert from 'node:assert/strict';
import { WeChatPocResponder } from './responder.mjs';

const calls = [];
const runtimeClient = {
  async run(prompt, options) {
    calls.push({ prompt, options });
    return { text: `我在，你说。${'好'.repeat(4000)}` };
  },
};
const state = {
  history() {
    return [
      { role: 'user', content: '上次的问题' },
      { role: 'assistant', content: '上次的回复' },
    ];
  },
};
const responder = new WeChatPocResponder({
  runtimeClient,
  state,
  personaText: 'PERSONA_TEST',
  bibleText: 'BIBLE_TEST',
  privacyBoundaryText: 'PRIVACY_BOUNDARY_TEST',
  cwd: '/tmp/aipro-wechat-poc',
  model: 'gpt-test',
  timeoutMs: 30_000,
});
const event = {
  chatId: 'wechat-poc:user:abc',
  senderId: 'sender-abc',
  conversationKind: 'direct',
  text: '现在方便吗？',
};

const reply = await responder.reply(event);
assert.equal(reply.length, 3800);
assert.match(calls[0].prompt, /PERSONA_TEST/);
assert.match(calls[0].prompt, /BIBLE_TEST/);
assert.match(calls[0].prompt, /PRIVACY_BOUNDARY_TEST/);
assert.match(calls[0].prompt, /个人微信单聊/);
assert.match(calls[0].prompt, /上次的问题/);
assert.match(calls[0].prompt, /现在方便吗/);
assert.equal(calls[0].options.cwd, '/tmp/aipro-wechat-poc');
assert.equal(calls[0].options.model, 'gpt-test');
assert.equal(calls[0].options.timeoutMs, 30_000);

const groupResponder = new WeChatPocResponder({
  runtimeClient: { run: async prompt => ({ text: prompt.includes('群聊明确 @') ? '群聊回复' : '' }) },
  state,
  personaText: 'P',
  bibleText: 'B',
  cwd: '/tmp/aipro-wechat-poc',
});
assert.equal(await groupResponder.reply({ ...event, conversationKind: 'group' }), '群聊回复');

console.log('WECHAT_POC_RESPONDER_TEST_OK');
