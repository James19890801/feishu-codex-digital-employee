import assert from 'node:assert/strict';
import {
  buildOwnerConsultationMessage,
  buildRequesterRelay,
  buildSourceLocationLabel,
  detectOwnerConsultationRequest,
  parseOwnerConsultationDecision,
} from './owner-consultation.mjs';

assert.equal(buildSourceLocationLabel({
  channel: 'wechat', chatType: 'group', chatId: 'wechat:group:room@chatroom',
  groupName: 'AI流程与组织变革交流一群',
}), '微信群「AI流程与组织变革交流一群」');
assert.equal(buildSourceLocationLabel({
  channel: 'wechat', chatType: 'group', chatId: 'wechat:group:room@chatroom',
}), '微信群（ID：room@chatroom）');
assert.equal(buildSourceLocationLabel({
  channel: 'wechat', chatType: 'p2p', chatId: 'wechat:user:wxid_yichen',
}), '与我的微信单聊');
assert.equal(buildSourceLocationLabel({
  channel: 'dingtalk', chatType: 'group', chatId: 'dingtalk:group:cid123',
  groupName: '项目交流群',
}), '钉钉群「项目交流群」');

assert.equal(detectOwnerConsultationRequest({ text: '你去问一下詹老师，他同不同意' }).triggered, true);
assert.equal(detectOwnerConsultationRequest({ text: '请詹老师确认后告诉我' }).triggered, true);
assert.equal(detectOwnerConsultationRequest({ text: '帮我转达给詹老师，我周二有空' }).triggered, true);
assert.equal(detectOwnerConsultationRequest({ text: '詹老师今天讲得很好' }).triggered, false);
assert.equal(detectOwnerConsultationRequest({ text: '不用去问詹老师' }).triggered, false);
assert.equal(detectOwnerConsultationRequest({ text: '他说“你去问詹老师”' }).triggered, false);
assert.equal(detectOwnerConsultationRequest({
  text: '好，你去问吧',
  recentAssistantText: '这个需要詹老师本人确认。要我去问他吗？',
}).triggered, true);

const ownerMessage = buildOwnerConsultationMessage({
  requesterLabel: '一尘老师',
  requestText: '下周能不能安排一次交流？',
  decisionPrompt: '是否同意安排一次交流',
  suggestedReply: '詹老师同意进一步沟通，稍后再确认具体时间。',
});
assert.match(ownerMessage, /一尘老师/);
assert.match(ownerMessage, /是否同意安排一次交流/);
assert.match(ownerMessage, /建议回复/);
assert.match(ownerMessage, /引用这条消息/);
assert.doesNotMatch(ownerMessage, /Q\d|编号|consultation/i);

const costApprovalMessage = buildOwnerConsultationMessage({
  requesterLabel: '一尘老师',
  requesterId: 'wechat:wxid_yichen',
  locationLabel: '微信群「AI流程与组织变革交流一群」',
  requestText: '生成一份完整的行业调研报告并做成 PPT。',
  decisionPrompt: '是否同意生成这份行业调研 PPT',
  purpose: 'cost_approval',
  costCategory: 'long_report',
});
assert.match(costApprovalMessage, /微信用户「一尘老师」/);
assert.match(costApprovalMessage, /微信 ID：wxid_yichen/);
assert.match(costApprovalMessage, /微信群「AI流程与组织变革交流一群」/);
assert.match(costApprovalMessage, /想让我做/);
assert.match(costApprovalMessage, /完整的行业调研报告/);
assert.match(costApprovalMessage, /长篇报告任务/);
assert.match(costApprovalMessage, /请求您的同意/);

assert.deepEqual(parseOwnerConsultationDecision('同意'), { kind: 'approve', approvedReply: '' });
assert.deepEqual(parseOwnerConsultationDecision('不同意'), { kind: 'reject', approvedReply: '' });
assert.deepEqual(parseOwnerConsultationDecision('改成：告诉她我周二下午有空'), {
  kind: 'revise', approvedReply: '告诉她我周二下午有空',
});
assert.deepEqual(parseOwnerConsultationDecision('告诉她，我周二下午有空'), {
  kind: 'revise', approvedReply: '我周二下午有空',
});
assert.deepEqual(parseOwnerConsultationDecision('这个我再想想'), { kind: 'ambiguous', approvedReply: '' });

assert.equal(buildRequesterRelay({ decision: 'approve', approvedReply: '可以安排。' }), '我问过詹老师了，他回复：可以安排。');
assert.equal(buildRequesterRelay({ decision: 'reject' }), '我问过詹老师了，他暂时没有同意这件事。');

console.log('OWNER_CONSULTATION_POLICY_TEST_OK');
