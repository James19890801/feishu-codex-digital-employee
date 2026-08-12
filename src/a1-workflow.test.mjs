import assert from 'node:assert/strict';
import { A1RequirementWorkflow } from './a1-workflow.mjs';
import { normalizeDingTalkSelfMessages } from './im-channels.mjs';

class FakePendingStore {
  constructor() { this.items = new Map(); }
  key(kind, chatId, senderId) { return `${kind}:${chatId}:${senderId}`; }
  get(kind, chatId, senderId) { return this.items.get(this.key(kind, chatId, senderId)) || null; }
  set(kind, chatId, senderId, value) { this.items.set(this.key(kind, chatId, senderId), value); }
  delete(kind, chatId, senderId) { this.items.delete(this.key(kind, chatId, senderId)); }
}

function buildWorkflow() {
  const calls = [];
  const subscriptions = [];
  const prepared = [];
  const client = {
    async createRequirement(input) {
      calls.push({ operation: 'create', input });
      return {
        id: '90000001', title: input.title, status: '待处理', assignee: input.assignee,
        projectId: input.projectId, projectName: 'WebAgent需求池',
        url: 'https://project.aone.alibaba-inc.com/v2/project/2165415/req/90000001',
        description: input.body,
      };
    },
    async updateRequirement(id, input) {
      calls.push({ operation: 'update', id, input });
      return {
        id, title: input.title || '支付流程', status: '待处理', assignee: input.assignee || '黑撒',
        projectId: '2165415', projectName: 'WebAgent需求池',
        url: `https://project.aone.alibaba-inc.com/v2/project/2165415/req/${id}`,
        description: input.body,
      };
    },
    async getWorkitem(id) {
      calls.push({ operation: 'get', id });
      return {
        id, title: '支付流程', status: '开发中', assignee: '黑撒', projectId: '2165415',
        projectName: 'WebAgent需求池', updatedAt: '2026-08-03 10:00:00',
        url: `https://project.aone.alibaba-inc.com/v2/project/2165415/req/${id}`, description: '# body',
      };
    },
    async listRequirements({ projectId }) {
      calls.push({ operation: 'list', projectId });
      return [];
    },
  };
  const prepareRequirement = async input => {
    prepared.push(input);
    return {
      title: '支付流程',
      background: '当前流程缺失。',
      goals: ['完成支付闭环'],
      requirements: [{ name: '支付', detail: '支持基础支付。', priority: 'P0' }],
      codeEvidence: input.route.inspectRepository ? [{ path: 'src/pay.ts', finding: '支付入口' }] : [],
      acceptanceCriteria: ['可以完成支付'],
      risks: ['需要校验权限'],
      openQuestions: [],
    };
  };
  const workflow = new A1RequirementWorkflow({
    client,
    pendingStore: new FakePendingStore(),
    prepareRequirement,
    subscribe: value => subscriptions.push(value),
  });
  return { workflow, calls, subscriptions, prepared };
}

const external = {
  chatId: 'dingtalk:user:requester', senderId: 'dingtalk:requester', chatType: 'p2p',
  messageId: 'm1', requester: '需求同学',
  history: '需求同学：证照用印自动化需要一个下拉框组件。',
  metadata: { channel: 'dingtalk', senderName: '需求同学' },
};

const ownerSelfChat = {
  chatId: 'dingtalk:user:owner', senderId: 'dingtalk:owner', chatType: 'p2p',
  messageId: 'self-1', requester: 'dingtalk:owner',
  history: '（这是当前运行周期内的第一条消息）',
  metadata: { channel: 'dingtalk', selfChat: true, ownerLabel: '阿充' },
};

{
  const { workflow, calls, subscriptions, prepared } = buildWorkflow();
  const created = await workflow.handle({
    ...external,
    text: '帮黑撒建一个 WebAgent 的 1A 需求：支付流程',
  });
  assert.match(created.text, /已创建需求/);
  const create = calls.find(call => call.operation === 'create');
  assert.equal(create.input.projectId, '2165415');
  assert.equal(create.input.assignee, '黑撒');
  assert.equal(create.input.priority, '高');
  assert.match(create.input.body, /提出人：需求同学/);
  assert.match(prepared[0].request, /证照用印自动化/);
  assert.equal(calls.at(-1).operation, 'get');
  assert.equal(subscriptions.length, 1);

  const followUp = await workflow.handle({
    ...external,
    messageId: 'm1-follow-up',
    text: '这个需求你能不能决定',
  });
  assert.match(followUp.text, /已经创建/);
  assert.match(followUp.text, /90000001/);
  assert.equal(calls.filter(call => call.operation === 'create').length, 1);
}

{
  const { workflow, calls } = buildWorkflow();
  const created = await workflow.handle({
    ...external,
    messageId: 'm2',
    text: '有一个 WebAgent 需求：增加数据源配置',
  });
  assert.match(created.text, /已创建需求/);
  assert.equal(calls.find(call => call.operation === 'create').input.assignee, '');
}

{
  const { workflow, calls } = buildWorkflow();
  const created = await workflow.handle({
    ...ownerSelfChat,
    text: '帮我建一个 WebAgent 的 A1 需求：支持阿里钉自聊直接建需求',
  });
  assert.match(created.text, /已创建需求/);
  assert.deepEqual(
    calls.map(call => call.operation),
    ['create', 'get'],
    '钉钉自聊需求应直接创建并回读，不应经过确认卡控',
  );
  assert.match(calls[0].input.body, /提出人：阿充（钉钉自聊）/);
}

{
  const [payload] = normalizeDingTalkSelfMessages({
    result: {
      messages: [{
        openMessageId: 'self-dws-1',
        senderOpenDingTalkId: 'open-owner',
        openConversationId: 'cid-owner-self',
        createTime: '2026-08-06 17:00:00',
        content: '帮我建一个 WebAgent 需求：自聊也能创建 A1',
      }],
    },
  });
  const { workflow, calls } = buildWorkflow();
  const created = await workflow.handle({
    chatId: payload.message.chat_id,
    senderId: payload.sender.sender_id.open_id,
    chatType: payload.message.chat_type,
    messageId: payload.message.message_id,
    text: JSON.parse(payload.message.content).text,
    requester: payload.sender.sender_id.open_id,
    metadata: { ...payload.metadata, ownerLabel: '阿充' },
  });
  assert.match(created.text, /已创建需求/);
  assert.equal(payload.metadata.selfChat, true);
  assert.deepEqual(calls.map(call => call.operation), ['create', 'get']);
}

{
  const { workflow, calls } = buildWorkflow();
  const unknown = await workflow.handle({
    ...external,
    messageId: 'm3',
    text: '帮黑撒新建一个供应链预测系统需求',
  });
  assert.match(unknown.text, /WebAgent.*AI协同空间/);
  assert.equal(calls.length, 0);
}

{
  const { workflow, calls } = buildWorkflow();
  const updated = await workflow.handle({
    ...external,
    messageId: 'm4',
    text: '把 90000001 需求补充为支持外部数据源',
  });
  assert.match(updated.text, /已更新需求/);
  assert.ok(calls.some(call => call.operation === 'update'));
  assert.equal(calls.at(-1).operation, 'get');
}

{
  const { workflow, calls } = buildWorkflow();
  const progress = await workflow.handle({
    ...external,
    messageId: 'm5',
    text: '90000001 需求进度怎么样？',
  });
  assert.match(progress.text, /开发中/);
  assert.match(progress.text, /黑撒/);
  assert.equal(calls.at(-1).operation, 'get');
}

{
  const { workflow, calls } = buildWorkflow();
  const unrelated = await workflow.handle({
    ...external,
    messageId: 'm6',
    text: '你还好吗？还活着不 我需要你帮忙',
    history: '助理：你要查 WebAgent 还是 AI协同空间的需求进度？也可以直接发工作项 ID。',
  });
  assert.deepEqual(
    unrelated,
    { handled: false, text: '' },
    'stale requirement history must not turn an unrelated current message into a progress query',
  );
  assert.equal(calls.length, 0);
}

console.log('a1-workflow tests passed');
