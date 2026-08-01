import assert from 'node:assert/strict';
import {
  assetUrlFromResult,
  buildDeliveryPlan,
  parseOnlineSheetModel,
  sheetModelToCsv,
  sheetModelToValues,
} from './delivery-routing.mjs';

assert.deepEqual(buildDeliveryPlan({
  chatId: 'dingtalk:user:open-user',
  request: '请给我出一份招聘优化方案',
}), { kind: 'online_document', provider: 'dingtalk', reason: 'channel_native_document' });

assert.deepEqual(buildDeliveryPlan({
  chatId: 'oc_feishu_chat',
  request: '整理一份项目复盘报告',
}), { kind: 'online_document', provider: 'feishu', reason: 'channel_native_document' });

assert.deepEqual(buildDeliveryPlan({
  chatId: 'dingtalk:group:cid',
  request: '做一个招聘数据分析表格',
}), { kind: 'online_spreadsheet', provider: 'dingtalk', reason: 'channel_native_spreadsheet' });

assert.deepEqual(buildDeliveryPlan({
  chatId: 'oc_feishu_chat',
  request: '给我做一个预算台账',
}), { kind: 'online_spreadsheet', provider: 'feishu', reason: 'channel_native_spreadsheet' });

assert.equal(buildDeliveryPlan({
  chatId: 'wecom:user:zhangsan',
  request: '整理一份项目方案',
}).kind, 'online_unavailable');

for (const request of ['生成一份 Word 方案', '把报告做成PDF附件']) {
  assert.equal(buildDeliveryPlan({ chatId: 'dingtalk:user:u1', request }).kind, 'local_file');
}
assert.equal(buildDeliveryPlan({
  chatId: 'oc_feishu_chat',
  request: '实现一个接口并修改项目代码',
}).kind, 'local_file');
assert.equal(buildDeliveryPlan({ chatId: 'oc_feishu_chat', request: '你好，在吗' }).kind, 'message');

const sheet = parseOnlineSheetModel('```json\n{"title":"招聘看板","columns":["渠道","人数"],"rows":[["内推",12],["猎头",5]]}\n```');
assert.deepEqual(sheet, {
  title: '招聘看板',
  columns: ['渠道', '人数'],
  rows: [['内推', 12], ['猎头', 5]],
});
assert.deepEqual(sheetModelToValues(sheet), [['渠道', '人数'], ['内推', 12], ['猎头', 5]]);
assert.equal(sheetModelToCsv(sheet), '渠道,人数\r\n内推,12\r\n猎头,5');
assert.equal(sheetModelToCsv({
  columns: ['说明'], rows: [['包含,逗号和"引号"']],
}), '说明\r\n"包含,逗号和""引号"""');

assert.equal(assetUrlFromResult({
  ok: true, data: { document: { url: 'https://example.feishu.cn/docx/abc' } },
}), 'https://example.feishu.cn/docx/abc');
assert.equal(assetUrlFromResult({
  success: true, result: { nodeUrl: 'https://alidocs.dingtalk.com/i/nodes/abc' },
}), 'https://alidocs.dingtalk.com/i/nodes/abc');

console.log('DELIVERY_ROUTING_TEST_OK');
