import assert from 'node:assert/strict';
import {
  extendPendingCreateDelivery,
  isPendingWeChatMulticaContinuation,
} from './multica-group-routing.mjs';

const base = {
  channel: 'wechat',
  chatType: 'group',
  contextOnly: true,
};

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '1',
  pendingCreateRoute: {
    stage: 'workspace',
    workspaces: [{ id: 'ws-1', name: '默认空间' }],
  },
}), true, '原发起人可以在群里直接回复空间序号');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '执行小队',
  pendingCreateRoute: {
    stage: 'squad',
    squads: [{ id: 'squad-1', name: '执行小队' }],
  },
}), true, '原发起人可以在群里直接回复小队名称');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '最后的交付是一个 PDF',
  pendingCreateRoute: {
    stage: 'workspace',
    workspaces: [{ id: 'ws-1', name: '默认空间' }],
  },
}), true, '原发起人不重复 @ 也能追加文件交付要求');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '确认 123456',
  pendingMutation: {
    confirmationCode: '123456',
    pending: { plan: { confirmationLevel: 'double' } },
  },
}), true, '原发起人可以不重复 @ 直接确认');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '确认123456',
  pendingMutation: {
    confirmationCode: '123456',
    pending: { plan: { confirmationLevel: 'double' } },
  },
}), true, '无空格的六位确认码也必须命中待办');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '取消',
  pendingMutation: {
    confirmationCode: '123456',
    pending: { plan: { confirmationLevel: 'double' } },
  },
}), true);

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '大家下午好',
  pendingCreateRoute: {
    stage: 'workspace',
    workspaces: [{ id: 'ws-1', name: '默认空间' }],
  },
}), false, '无关群聊不能误消费待确认操作');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  text: '确认 123456',
  pendingMutation: null,
}), false, '其他成员查不到原发起人的 pending，不能代为确认');

assert.equal(isPendingWeChatMulticaContinuation({
  ...base,
  channel: 'dingtalk',
  text: '确认 123456',
  pendingMutation: { confirmationCode: '123456' },
}), false);

const pendingWithPdf = extendPendingCreateDelivery({
  stage: 'workspace',
  originalRequest: '创建一个 Issue，制作一份攻略',
  plan: {
    action: 'create',
    fields: { description: '制作一份攻略' },
  },
  workspaces: [{ id: 'ws-1', name: '默认空间' }],
}, {
  request: '最后的交付是一个 PDF',
  channel: 'wechat',
  chatId: 'wechat:group:room-1@chatroom',
  senderId: 'wechat:member-1',
  chatType: 'group',
});

assert.equal(pendingWithPdf.matched, true, '待创建期间的 PDF 补充要合并到同一个任务');
assert.deepEqual(pendingWithPdf.pending.deliveryContract.formats, ['pdf']);
assert.equal(pendingWithPdf.pending.deliveryContract.chatId, 'wechat:group:room-1@chatroom');
assert.equal(pendingWithPdf.pending.deliveryContract.senderId, 'wechat:member-1');
assert.match(pendingWithPdf.pending.plan.fields.description, /最终产物格式：PDF/);
assert.match(pendingWithPdf.pending.originalRequest, /最后的交付是一个 PDF/);

assert.deepEqual(extendPendingCreateDelivery({
  stage: 'workspace',
  plan: { action: 'create', fields: {} },
}, {
  request: '大家下午好',
  channel: 'wechat',
  chatId: 'wechat:group:room-1@chatroom',
  senderId: 'wechat:member-1',
  chatType: 'group',
}), { matched: false }, '普通群聊不能被误合并');

console.log('MULTICA_GROUP_ROUTING_TEST_OK');
