import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { PendingActionStore } from './pending-actions.mjs';
import { MailWorkflow, isAuthorizedMailOwner } from './mail-workflow.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aipro-mail-workflow-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const pendingStore = new PendingActionStore(state, { kindTtlMs: { mail_write: 15 * 60_000 } });
  const calls = [];
  const client = {
    async listMailboxes() { calls.push(['list']); return [{ email: 'owner@example.com', type: 'ORG' }]; },
    async searchMessages(input) {
      calls.push(['search', input]);
      return { messages: [{ id: 'm1', subject: '周报', from: { name: '张三', email: 'zhang@example.com' }, receivedDateTime: '2026-08-05T01:00:00Z', isRead: false, hasAttachments: false }] };
    },
    async getMessage(input) {
      calls.push(['get', input]);
      return { id: 'm1', subject: '周报', from: { name: '张三', email: 'zhang@example.com' }, to: [], cc: [], receivedDateTime: '2026-08-05T01:00:00Z', markdownBody: '本周完成 A' };
    },
    async searchMailUsers(input) { calls.push(['users', input]); return [{ id: 'u1', name: input.keyword, email: 'target@example.com' }]; },
    async searchContactUsers() { return []; },
    async sendMessage(input) { calls.push(['send', input]); return { internetMessageId: '<sent@example.com>', messageId: 'sent-1' }; },
    async replyMessage(input) { calls.push(['reply', input]); return { internetMessageId: '<reply@example.com>', messageId: 'reply-1' }; },
    async replyAllMessage(input) { calls.push(['reply_all', input]); return { internetMessageId: '<reply-all@example.com>', messageId: 'reply-all-1' }; },
    async forwardMessage(input) { calls.push(['forward', input]); return { internetMessageId: '<forward@example.com>', messageId: 'forward-1' }; },
    async verifyDelivery(input) { calls.push(['verify', input]); return 'success'; },
  };
  const workflow = new MailWorkflow({
    client, state, pendingStore, ownerIds: ['enterpriseChat:owner'], now: () => 10_000,
    delay: async () => {},
  });
  const owner = {
    chatId: 'enterpriseChat:user:owner', chatType: 'p2p', senderId: 'enterpriseChat:owner',
    messageId: 'msg-1', metadata: { channel: 'enterpriseChat', selfChat: true },
  };

  assert.equal(isAuthorizedMailOwner(owner, ['enterpriseChat:owner']), true);
  assert.equal(isAuthorizedMailOwner({ ...owner, chatType: 'group' }, ['enterpriseChat:owner']), false);
  assert.equal(isAuthorizedMailOwner({ ...owner, metadata: { channel: 'enterpriseChat', selfChat: false } }, ['enterpriseChat:owner']), false);

  const denied = await workflow.handle({ ...owner, senderId: 'enterpriseChat:other', text: '看看未读邮件' });
  assert.equal(denied.handled, true);
  assert.match(denied.text, /仅能在本人企业会话私聊/);
  assert.equal(calls.length, 0);

  const searched = await workflow.handle({ ...owner, text: '看看未读邮件' });
  assert.equal(searched.handled, true);
  assert.match(searched.text, /1\. \[未读\] 周报/);
  assert.equal(searched.sensitive, true);
  assert.match(calls.find(call => call[0] === 'search')[1].query, /folderId:2 AND isRead:false/);

  const opened = await workflow.handle({ ...owner, messageId: 'msg-2', text: '打开第 1 封邮件' });
  assert.match(opened.text, /本周完成 A/);
  assert.equal(opened.sensitive, true);

  const preview = await workflow.handle({ ...owner, messageId: 'msg-send', text: '给 张三 发邮件，主题：周报，正文：本周完成 A' });
  assert.match(preview.text, /发送前确认/);
  assert.match(preview.text, /target@example\.com/);
  assert.match(preview.text, /15 分钟内回复“确认”/);
  assert.equal(calls.some(call => call[0] === 'send'), false);

  const confirmed = await workflow.handle({ ...owner, messageId: 'msg-confirm', text: '确认' });
  assert.match(confirmed.text, /投递成功/);
  assert.equal(calls.filter(call => call[0] === 'send').length, 1);
  assert.equal(calls.filter(call => call[0] === 'verify').length, 1);
  const repeated = await workflow.handle({ ...owner, messageId: 'msg-confirm-2', text: '确认' });
  assert.equal(repeated.handled, false);
  assert.equal(calls.filter(call => call[0] === 'send').length, 1);

  await workflow.handle({ ...owner, messageId: 'msg-reply', text: '回复第 1 封，正文：收到' });
  await workflow.handle({ ...owner, messageId: 'msg-reply-confirm', text: '确认发送' });
  assert.equal(calls.filter(call => call[0] === 'reply').length, 1);

  await workflow.handle({ ...owner, messageId: 'msg-forward', text: '转发第 1 封给 李四，附言：请查看' });
  await workflow.handle({ ...owner, messageId: 'msg-forward-cancel', text: '取消' });
  assert.equal(calls.filter(call => call[0] === 'forward').length, 0);

  console.log('MAIL_WORKFLOW_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
