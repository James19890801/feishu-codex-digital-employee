import assert from 'node:assert/strict';
import { buildDeliveryPlan } from './delivery-routing.mjs';

const requests = [
  ['dingtalk:user:open-user', '请给我出一份招聘优化方案'],
  ['oc_feishu_chat', '整理一份项目复盘报告'],
  ['dingtalk:group:cid', '做一个招聘数据分析表格'],
  ['oc_feishu_chat', '给我做一个预算台账'],
  ['wecom:user:zhangsan', '整理一份项目方案'],
  ['dingtalk:user:u1', '生成一份 Word 方案'],
  ['oc_feishu_chat', '把报告做成PDF附件'],
  ['oc_feishu_chat', '实现一个接口并修改项目代码'],
  ['oc_feishu_chat', '你好，在吗'],
];

for (const [chatId, request] of requests) {
  const plan = buildDeliveryPlan({ chatId, request });
  assert.equal(plan.kind, 'message', `${request} must go directly to the AI agent`);
  assert.equal(plan.reason, 'agent_runtime');
}

console.log('DELIVERY_ROUTING_TEST_OK');
