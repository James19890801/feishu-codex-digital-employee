import assert from 'node:assert/strict';
import { A1RequirementWorkflow } from './a1-workflow.mjs';

class FakePendingStore {
  constructor() { this.items = new Map(); }
  key(kind, chatId, senderId) { return `${kind}:${chatId}:${senderId}`; }
  get(kind, chatId, senderId) { return this.items.get(this.key(kind, chatId, senderId)) || null; }
  set(kind, chatId, senderId, value) { this.items.set(this.key(kind, chatId, senderId), value); }
  delete(kind, chatId, senderId) { this.items.delete(this.key(kind, chatId, senderId)); }
}

const calls = [];
const client = {
  async createRequirement(input) {
    calls.push({ operation: 'create', input });
    return {
      id: '90000001', title: input.title, status: '待处理', assignee: '', projectName: 'WebAgent需求池',
      url: 'https://project.aone.alibaba-inc.com/v2/project/2165415/req/90000001', description: input.body,
    };
  },
  async updateRequirement(id, input) {
    calls.push({ operation: 'update', id, input });
    return {
      id, title: input.title || '支付流程', status: '待处理', assignee: '黑撒', projectName: 'WebAgent需求池',
      url: `https://project.aone.alibaba-inc.com/v2/project/2165415/req/${id}`, description: input.body,
    };
  },
  async getWorkitem(id) {
    calls.push({ operation: 'get', id });
    return {
      id, title: '支付流程', status: '开发中', assignee: '黑撒', projectName: 'WebAgent需求池', updatedAt: '2026-08-03 10:00:00',
      url: `https://project.aone.alibaba-inc.com/v2/project/2165415/req/${id}`, description: '# body',
    };
  },
  async listRequirements({ projectId }) {
    calls.push({ operation: 'list', projectId });
    return [{ id: '90000001', title: '支付流程', status: '开发中' }];
  },
};

const prepared = [];
const prepareRequirement = async input => {
  prepared.push(input);
  return {
    title: '支付流程',
    background: '当前流程缺失。',
    goals: ['完成支付闭环'],
    requirements: [{ name: '支付', detail: input.clarification ? `支持${input.clarification}` : '支持基础支付。', priority: 'P0' }],
    codeEvidence: input.route.inspectRepository ? [{ path: 'src/pay.ts', finding: '支付入口' }] : [],
    acceptanceCriteria: ['可以完成支付'],
    risks: ['需要校验权限'],
    openQuestions: input.clarification ? [] : ['需要支持哪些支付方式？'],
  };
};

const subscriptions = [];
const workflow = new A1RequirementWorkflow({
  client,
  pendingStore: new FakePendingStore(),
  prepareRequirement,
  subscribe: value => subscriptions.push(value),
});
const context = { chatId: 'dingtalk:user:1', senderId: 'dingtalk:1', chatType: 'p2p', messageId: 'm1' };

const clarification = await workflow.handle({ ...context, text: '帮我做一个支付流程需求' });
assert.equal(clarification.handled, true);
assert.match(clarification.text, /WebAgent.*AI协同空间.*其他产品/);
assert.equal(calls.length, 0);

const created = await workflow.handle({ ...context, messageId: 'm2', text: 'WebAgent' });
assert.match(created.text, /已创建/);
assert.match(created.text, /90000001/);
assert.match(created.text, /需要支持哪些支付方式/);
assert.equal(calls[0].operation, 'create');
assert.equal(calls[0].input.projectId, '2165415');
assert.match(calls[0].input.body, /## 背景与现状/);
assert.equal(subscriptions.length, 1);

const refined = await workflow.handle({ ...context, messageId: 'm3', text: '支付宝和银行卡' });
assert.match(refined.text, /已更新/);
assert.match(calls.at(-1).input.body, /支付宝和银行卡/);

const progress = await workflow.handle({ ...context, messageId: 'm4', text: '90000001 需求进度怎么样？' });
assert.match(progress.text, /开发中/);
assert.match(progress.text, /黑撒/);
assert.match(progress.text, /https:\/\/project\.aone/);

const otherPending = await workflow.handle({ ...context, senderId: 'dingtalk:2', messageId: 'm5', text: '新建一个供应链预测需求' });
assert.match(otherPending.text, /其他产品/);
const otherCreated = await workflow.handle({ ...context, senderId: 'dingtalk:2', messageId: 'm6', text: '供应链预测系统' });
assert.match(otherCreated.text, /已创建/);
assert.equal(prepared.at(-1).route.classificationPending, true);
assert.equal(prepared.at(-1).route.inspectRepository, false);

console.log('a1-workflow tests passed');
