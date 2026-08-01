import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { isAuthorizedMulticaOwner } from './multica-access.mjs';
import {
  MulticaFeedbackWorkflow,
  feedbackClarificationQuestion,
  isFeedbackCancellation,
  looksLikeMulticaFeedback,
} from './multica-feedback.mjs';

assert.equal(looksLikeMulticaFeedback('AIPRO 回复偶尔报错，我要反馈一个 Bug'), true);
assert.equal(looksLikeMulticaFeedback('给数字人提个功能需求：支持状态回传'), true);
assert.equal(looksLikeMulticaFeedback('查一下 MYS-6'), false);
assert.equal(looksLikeMulticaFeedback('今天天气怎么样'), false);
assert.equal((feedbackClarificationQuestion().match(/？/g) || []).length, 1);
assert.equal(isFeedbackCancellation('取消'), true);
assert.equal(isFeedbackCancellation('不用登记了。'), true);
assert.equal(isFeedbackCancellation('补充验收标准'), false);

function fixture({ failDispatch = false, existingIssues = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aipro-feedback-'));
  const state = new AgentState(join(dir, 'state.sqlite'));
  const creates = [];
  const updates = [];
  const audits = [];
  let shouldFailDispatch = failDispatch;
  const issues = structuredClone(existingIssues);
  const client = {
    listWorkspaces: async () => [{ id: 'ws-1', name: 'My Space', slug: 'my-space' }],
    searchIssues: async query => issues.filter(item => String(item.description || '').includes(query)),
    createIssue: async fields => {
      creates.push(structuredClone(fields));
      const issue = {
        id: `issue-${creates.length}`,
        identifier: `MYS-${creates.length}`,
        workspace_id: fields.workspaceId,
        title: fields.title,
        description: fields.description,
        status: fields.status,
        priority: fields.priority,
        assignee_id: null,
        updated_at: '2026-08-02T00:00:00.000Z',
      };
      issues.push(issue);
      return structuredClone(issue);
    },
    updateIssue: async (issueId, fields) => {
      updates.push({ issueId, fields: structuredClone(fields) });
      if (shouldFailDispatch) throw new Error('temporary squad dispatch failure');
      const issue = issues.find(item => item.id === issueId);
      Object.assign(issue, fields, {
        assignee_name: fields.assignee,
        updated_at: '2026-08-02T00:01:00.000Z',
      });
      return structuredClone(issue);
    },
  };
  const workflow = new MulticaFeedbackWorkflow({
    client,
    state,
    workspaceId: 'ws-1',
    ownerSquad: '詹老师的开发团伙',
    appUrl: 'https://multica.ai',
    audit: (event, detail) => audits.push({ event, detail }),
    maxDispatchAttempts: 3,
    authorizeOwner: context => isAuthorizedMulticaOwner(context, {
      ownerOpenId: 'ou_owner',
      dingtalkOwnerOpenId: 'dt_owner',
    }),
  });
  return {
    state,
    workflow,
    creates,
    updates,
    audits,
    issues,
    allowDispatch: () => { shouldFailDispatch = false; },
    close: () => {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const nonOwnerContext = {
  chatId: 'dingtalk:user:reporter',
  senderId: 'dingtalk:reporter',
  chatType: 'p2p',
  metadata: { channel: 'dingtalk' },
};
const ownerContext = {
  chatId: 'oc_owner_self',
  senderId: 'ou_owner',
  chatType: 'p2p',
  metadata: { channel: 'feishu', selfChat: true },
};

const ownerGroupContext = {
  chatId: 'oc_owner_group',
  senderId: 'ou_owner',
  chatType: 'group',
  metadata: { channel: 'feishu', selfChat: true },
};

const ownerOrdinaryP2pContext = {
  chatId: 'oc_owner_with_other',
  senderId: 'ou_owner',
  chatType: 'p2p',
  metadata: { channel: 'feishu' },
};

const forgedSelfChatContext = {
  chatId: 'oc_forged_self',
  senderId: 'ou_attacker',
  chatType: 'p2p',
  metadata: { channel: 'feishu', selfChat: true },
};

{
  const test = fixture();
  try {
    const started = test.workflow.begin({
      text: 'AIPRO 发消息时偶尔报错',
      sourceMessageId: 'message-non-owner',
      context: nonOwnerContext,
    });
    assert.equal(started.kind, 'clarification');
    assert.equal(started.text, feedbackClarificationQuestion());
    assert.equal(test.creates.length, 0, 'the first feedback message must never create an Issue');
    const cancelled = test.workflow.cancel(started.pending, { context: nonOwnerContext });
    assert.match(cancelled.text, /没有创建 Multica Issue/);
    assert.equal(test.creates.length, 0, 'cancellation must not create an Issue');

    const registered = await test.workflow.register(
      started.pending,
      '连续发送 20 次均成功，且不能重复发送。',
      { context: nonOwnerContext, now: new Date('2026-08-02T00:00:00.000Z') },
    );
    assert.equal(registered.ownerDispatched, false);
    assert.equal(registered.issue.status, 'backlog');
    assert.equal(test.creates.length, 1);
    assert.equal(test.creates[0].assignee, undefined);
    assert.equal(test.creates[0].assigneeId, undefined);
    assert.match(test.creates[0].description, /来源渠道：dingtalk/);
    assert.match(test.creates[0].description, /原会话：dingtalk:user:reporter/);
    assert.match(test.creates[0].description, /原始需求：AIPRO 发消息时偶尔报错/);
    assert.match(test.creates[0].description, /验收标准：连续发送 20 次均成功/);
    assert.match(registered.text, /MYS-1/);
    assert.match(registered.text, /https:\/\/multica\.ai\/my-space\/issues\/MYS-1/);
    assert.deepEqual(test.state.multicaIssueSubscribers('issue-1'), [{
      chatId: nonOwnerContext.chatId,
      senderId: nonOwnerContext.senderId,
      chatType: 'p2p',
    }]);

    const replay = await test.workflow.register(
      started.pending,
      '不同文字也不能创建第二个 Issue',
      { context: nonOwnerContext, now: new Date('2026-08-02T00:02:00.000Z') },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.issue.id, 'issue-1');
    assert.equal(test.creates.length, 1);
  } finally {
    test.close();
  }
}

for (const [label, context] of [
  ['Owner group', ownerGroupContext],
  ['Owner ordinary p2p', ownerOrdinaryP2pContext],
  ['forged self-chat', forgedSelfChatContext],
]) {
  const test = fixture();
  try {
    const started = test.workflow.begin({
      text: `AIPRO 功能需求：${label} 反馈`,
      sourceMessageId: `message-${label}`,
      context,
      ownerAuthorized: true,
    });
    assert.equal(started.pending.ownerAuthorized, false, `${label} must fail closed at intake`);
    const registered = await test.workflow.register(
      started.pending,
      '完成后能看到登记结果。',
      { context, now: new Date('2026-08-02T00:00:00.000Z') },
    );
    assert.equal(registered.ownerDispatched, false, `${label} must not auto-dispatch`);
    assert.equal(registered.issue.status, 'backlog');
    assert.equal(test.updates.length, 0, `${label} must not update or assign the Issue`);
  } finally {
    test.close();
  }
}

{
  const test = fixture();
  try {
    const started = test.workflow.begin({
      text: 'AIPRO 功能需求：澄清完成时再次授权',
      sourceMessageId: 'message-owner-clarification-reauth',
      context: ownerContext,
    });
    const registered = await test.workflow.register(
      started.pending,
      '完成后能看到登记结果。',
      {
        context: {
          ...ownerContext,
          metadata: { channel: 'feishu' },
        },
        now: new Date('2026-08-02T00:00:00.000Z'),
      },
    );
    assert.equal(registered.ownerDispatched, false);
    assert.equal(test.updates.length, 0, 'clarification outside self-chat must not dispatch');
  } finally {
    test.close();
  }
}

{
  const test = fixture();
  try {
    const started = test.workflow.begin({
      text: '给数字人提个功能需求：支持进度同步',
      sourceMessageId: 'message-owner',
      context: ownerContext,
    });
    const registered = await test.workflow.register(
      started.pending,
      'Issue 状态变化后 10 秒内同步回当前会话。',
      { context: ownerContext, now: new Date('2026-08-02T00:00:00.000Z') },
    );
    assert.equal(registered.ownerDispatched, true);
    assert.deepEqual(test.updates[0], {
      issueId: 'issue-1',
      fields: {
        workspaceId: 'ws-1',
        assignee: '詹老师的开发团伙',
        status: 'todo',
      },
    });
    assert.equal(test.state.multicaDispatchPendingCount(), 0);
    assert.equal(test.audits.some(item => item.event === 'multica_feedback_dispatched'), true);

    const replay = await test.workflow.register(
      started.pending,
      '重复投递同一澄清消息。',
      { context: ownerContext, now: new Date('2026-08-02T00:02:00.000Z') },
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.ownerDispatched, true);
    assert.equal(test.updates.length, 1, 'successful Owner dispatch must not be repeated');
  } finally {
    test.close();
  }
}

{
  const test = fixture({ failDispatch: true });
  try {
    const started = test.workflow.begin({
      text: 'AIPRO 有个 Bug：状态不会回传',
      sourceMessageId: 'message-dispatch-failure',
      context: ownerContext,
    });
    const registered = await test.workflow.register(
      started.pending,
      '完成后原会话能收到 done 状态。',
      { context: ownerContext, now: new Date('2026-08-02T00:00:00.000Z') },
    );
    assert.equal(registered.ownerDispatched, false);
    assert.equal(registered.dispatchPending, true);
    assert.equal(registered.issue.status, 'backlog');
    assert.match(registered.text, /派发待重试/);
    assert.equal(test.state.multicaDispatchPendingCount(), 1);
    assert.deepEqual(test.state.multicaIssueSubscribers('issue-1').map(item => item.chatId), [
      ownerContext.chatId,
    ]);

    test.allowDispatch();
    const retried = await test.workflow.deliverDispatches(
      new Date('2026-08-02T00:10:00.000Z'),
    );
    assert.equal(retried.dispatched, 1);
    assert.equal(retried.failed, 0);
    assert.equal(retried.deadTotal, 0);
    assert.equal(test.state.multicaDispatchPendingCount(), 0);
  } finally {
    test.close();
  }
}

await assert.rejects(async () => {
  const test = fixture();
  try {
    const started = test.workflow.begin({
      text: 'AIPRO 有个 Bug',
      sourceMessageId: 'message-context',
      context: ownerContext,
    });
    await test.workflow.register(started.pending, '验收补充', {
      context: { ...ownerContext, senderId: 'ou_attacker' },
    });
  } finally {
    test.close();
  }
}, /context/i);

console.log('MULTICA_FEEDBACK_TEST_OK');
