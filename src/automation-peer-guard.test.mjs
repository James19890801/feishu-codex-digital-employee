import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  AUTOMATION_PEER_TERMINATION_TEXT,
  AutomationPeerGuard,
  detectExplicitAutomationPeer,
  handleAutomationPeerInbound,
} from './automation-peer-guard.mjs';

for (const text of [
  '你好，我是凤小楼，凤楼的 AI 助理。我可以帮你整理日程。',
  '我是阿充的数字人。',
  '本账号由智能助手自动回复。',
  '我是一个机器人，主人现在不在。',
  'Hi，我是 James 的 AI assistant。',
]) {
  assert.equal(
    detectExplicitAutomationPeer(text).matched,
    true,
    `explicit automation identity must be detected: ${text}`,
  );
}

for (const text of [
  '我是做数字人产品的，想体验一下。',
  '他说自己是数字人。',
  '帮我回复：“你好，我是你的 AI 助理。”',
  '你是不是机器人？',
  '我是张总的助理，想确认一下会议时间。',
]) {
  assert.equal(
    detectExplicitAutomationPeer(text).matched,
    false,
    `human discussion must not be classified as an automation identity: ${text}`,
  );
}

const runtimeDir = mkdtempSync(join(tmpdir(), 'automation-peer-guard-'));
const databasePath = join(runtimeDir, 'state.sqlite');
const state = new AgentState(databasePath);
const guard = new AutomationPeerGuard({ state });
const sent = [];

const first = await handleAutomationPeerInbound({
  guard,
  chatId: 'dingtalk:user:peer',
  senderId: 'dingtalk:peer',
  chatType: 'p2p',
  text: '你好，我是凤小楼，凤楼的AI助理。',
  messageId: 'm1',
  sendTermination: async text => {
    sent.push(text);
    return { success: true };
  },
});
assert.equal(first.handled, true);
assert.equal(first.notified, true);
assert.equal(first.decision.reason, 'explicit_automation_identity');
assert.deepEqual(sent, [AUTOMATION_PEER_TERMINATION_TEXT]);
assert.equal(AUTOMATION_PEER_TERMINATION_TEXT, '既然是数字人，我就不跟你玩了，浪费token。');

const reopenedState = new AgentState(databasePath);
const reopenedGuard = new AutomationPeerGuard({ state: reopenedState });
const again = await handleAutomationPeerInbound({
  guard: reopenedGuard,
  chatId: 'dingtalk:user:peer',
  senderId: 'dingtalk:peer',
  chatType: 'p2p',
  text: '你好，我还能继续帮你。',
  messageId: 'm2',
  sendTermination: async text => sent.push(text),
});
assert.equal(again.handled, true);
assert.equal(again.notified, false);
assert.equal(again.decision.action, 'suppress');
assert.equal(sent.length, 1, 'a blocked automation peer must never receive a second reply');

const human = await handleAutomationPeerInbound({
  guard,
  chatId: 'dingtalk:user:human',
  senderId: 'dingtalk:human',
  chatType: 'p2p',
  text: '我是做数字人产品的，想多体验几轮。',
  messageId: 'human-1',
  sendTermination: async text => sent.push(text),
});
assert.equal(human.handled, false);
assert.equal(human.decision.action, 'allow');

const groupBot = await handleAutomationPeerInbound({
  guard,
  chatId: 'dingtalk:group:team',
  senderId: 'dingtalk:bot',
  chatType: 'group',
  text: '我是团队的AI助理。',
  messageId: 'group-1',
  sendTermination: async text => sent.push(text),
});
assert.equal(groupBot.handled, false, 'group messages remain governed by the existing mention policy');

const failedChatId = 'dingtalk:user:send-failed';
await assert.rejects(
  handleAutomationPeerInbound({
    guard,
    chatId: failedChatId,
    senderId: 'dingtalk:send-failed',
    chatType: 'p2p',
    text: '我是账号的数字人。',
    messageId: 'failed-1',
    sendTermination: async () => { throw new Error('send failed'); },
  }),
  /send failed/,
);
const retryAfterFailure = guard.evaluateInbound({
  chatId: failedChatId,
  senderId: 'dingtalk:send-failed',
  chatType: 'p2p',
  text: '我是账号的数字人。',
});
assert.equal(retryAfterFailure.action, 'terminate', 'a failed notice must remain retryable');

reopenedState.db.close();
state.db.close();
rmSync(runtimeDir, { recursive: true, force: true });

console.log('AUTOMATION_PEER_GUARD_TEST_OK');
