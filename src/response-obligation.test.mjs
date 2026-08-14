import assert from 'node:assert/strict';
import {
  assessResponseObligation,
  normalizeResponseMentionAliases,
} from './response-obligation.mjs';

assert.deepEqual(
  normalizeResponseMentionAliases([' James ', '詹老师', 'James', '', null], ['数字人']),
  ['James', '詹老师', '数字人'],
);
assert.equal(
  normalizeResponseMentionAliases(Array.from({ length: 25 }, (_, index) => `alias-${index}`)).length,
  20,
);

const groupMessage = {
  chat_type: 'group',
  message_type: 'text',
  mentions: [],
};

assert.deepEqual(assessResponseObligation({
  message: { ...groupMessage, mentions: [{ id: 'dingtalk-current-user' }] },
  metadata: { channel: 'dingtalk', eventType: 'user_im_message_receive_at' },
  text: '@James 看一下',
  aliases: ['James', '詹老师'],
}), {
  explicitAssistantMention: true,
  responseRequired: true,
  reasonCode: 'structured_assistant_mention',
});

assert.deepEqual(assessResponseObligation({
  message: { ...groupMessage, mentions: [{ id: 'ou_current_assistant' }] },
  metadata: { channel: 'feishu' },
  text: '帮我看一下',
  aliases: ['James', '詹老师'],
}), {
  explicitAssistantMention: true,
  responseRequired: true,
  reasonCode: 'structured_assistant_mention',
});

assert.deepEqual(assessResponseObligation({
  message: groupMessage,
  metadata: { channel: 'dingtalk', admittedGroupMessage: true },
  text: '回头有能落地的规则再同步你。 @詹老师',
  aliases: ['James', '詹老师'],
}), {
  explicitAssistantMention: true,
  responseRequired: true,
  reasonCode: 'assistant_alias_mention',
});

assert.deepEqual(assessResponseObligation({
  message: groupMessage,
  metadata: { channel: 'dingtalk', admittedGroupMessage: true },
  text: '@小王 这个结论你看看',
  aliases: ['James', '詹老师'],
}), {
  explicitAssistantMention: false,
  responseRequired: false,
  reasonCode: 'other_mention',
});

assert.deepEqual(assessResponseObligation({
  message: groupMessage,
  metadata: { channel: 'dingtalk', admittedGroupMessage: true },
  text: '@小王 你也看看。 @詹老师',
  aliases: ['James', '詹老师'],
}), {
  explicitAssistantMention: true,
  responseRequired: true,
  reasonCode: 'assistant_alias_mention',
});

assert.deepEqual(assessResponseObligation({
  message: { ...groupMessage, chat_type: 'p2p' },
  metadata: { channel: 'dingtalk', eventType: 'user_im_message_receive_o2o_all' },
  text: '@詹老师 你好',
  aliases: ['詹老师'],
}), {
  explicitAssistantMention: false,
  responseRequired: false,
  reasonCode: 'not_group',
});

assert.deepEqual(assessResponseObligation({
  message: groupMessage,
  metadata: { channel: 'dingtalk', admittedGroupMessage: true },
  text: '我们在讨论詹老师的观点',
  aliases: ['詹老师'],
}), {
  explicitAssistantMention: false,
  responseRequired: false,
  reasonCode: 'not_addressed',
});

console.log('RESPONSE_OBLIGATION_TEST_OK');
