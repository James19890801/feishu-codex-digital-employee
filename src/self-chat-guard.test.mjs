import assert from 'node:assert/strict';
import {
  hasSelfChatOutboundMarker,
  markSelfChatOutbound,
  shouldSuppressSelfChatConversation,
  stripSelfChatOutboundMarker,
} from './self-chat-guard.mjs';

const reply = '这是一条正常回复';
const marked = markSelfChatOutbound(reply);
assert.notEqual(marked, reply);
assert.equal(hasSelfChatOutboundMarker(marked), true);
assert.equal(hasSelfChatOutboundMarker(reply), false);
assert.equal(stripSelfChatOutboundMarker(marked), reply);
assert.equal(markSelfChatOutbound(marked), marked, 'marker insertion must be idempotent');

assert.equal(shouldSuppressSelfChatConversation({
  selfChat: true,
  intent: 'conversation',
  operatorCommand: null,
}), true, 'ordinary owner self-chat text must never generate a reply to the owner');
assert.equal(shouldSuppressSelfChatConversation({
  selfChat: true,
  intent: 'a1_requirement',
  operatorCommand: null,
}), false, 'explicit owner tasks must remain available in self-chat');
assert.equal(shouldSuppressSelfChatConversation({
  selfChat: true,
  intent: 'conversation',
  operatorCommand: 'status',
}), false, 'explicit operator commands must remain available in self-chat');
assert.equal(shouldSuppressSelfChatConversation({
  selfChat: true,
  intent: 'conversation',
  pendingAction: true,
}), false, 'confirmations for pending owner actions must remain available in self-chat');
assert.equal(shouldSuppressSelfChatConversation({
  selfChat: false,
  intent: 'conversation',
  operatorCommand: null,
}), false, 'normal one-to-one conversations must still receive replies');

console.log('SELF_CHAT_GUARD_TEST_OK');
