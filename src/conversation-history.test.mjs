import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatConversationHistory } from './conversation-history.mjs';
import { AgentState } from './state.mjs';

const directory = mkdtempSync(join(tmpdir(), 'aipro-conversation-history-'));
try {
  const state = new AgentState(join(directory, 'state.sqlite'));
  for (let index = 1; index <= 32; index += 1) {
    const senderId = index % 3 === 0 ? 'owner' : 'contact';
    const role = index % 5 === 0 ? 'assistant' : 'user';
    state.remember('direct-chat', senderId, role, `单聊第${index}条`, {
      sourceMessageId: `direct-${index}`,
      createdAt: new Date(1_000 + index).toISOString(),
    });
  }
  const direct = formatConversationHistory(state, {
    chatId: 'direct-chat',
    currentSenderId: 'contact',
    chatType: 'p2p',
    excludeSourceMessageId: 'direct-32',
  });
  assert.equal(direct.split('\n').length, 31, 'direct chat must include all available messages up to the 50-message window');
  assert.equal(direct.includes('单聊第1条'), true);
  assert.equal(direct.includes('单聊第2条'), true);
  assert.match(direct, /真人本人：单聊第3条/);
  assert.match(direct, /对方：单聊第4条/);
  assert.match(direct, /助理：单聊第5条/);

  for (let index = 1; index <= 55; index += 1) {
    state.remember('group-chat-50', `member-${index % 4}`, 'user', `群聊第${index}条`, {
      sourceMessageId: `group-${index}`,
      createdAt: new Date(2_000 + index).toISOString(),
    });
    state.remember('other-group', 'other-member', 'user', `其他群第${index}条`, {
      sourceMessageId: `other-${index}`,
      createdAt: new Date(3_000 + index).toISOString(),
    });
  }
  const group = formatConversationHistory(state, {
    chatId: 'group-chat-50',
    currentSenderId: 'member-0',
    chatType: 'group',
    excludeSourceMessageId: 'group-55',
  });
  assert.equal(group.split('\n').length, 50, 'group chat must use the latest 50 messages from all participants');
  assert.equal(group.includes('群聊第1条'), false);
  assert.equal(group.includes('群聊第4条'), false);
  assert.equal(group.includes('群聊第5条'), true);
  assert.equal(group.includes('群聊第54条'), true);
  assert.equal(group.includes('群聊第55条'), false);
  assert.equal(group.includes('其他群'), false, 'history must never cross chat boundaries');
  assert.match(group, /群成员\[member-1\]：群聊第5条/);

  state.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('CONVERSATION_HISTORY_TEST_OK');
