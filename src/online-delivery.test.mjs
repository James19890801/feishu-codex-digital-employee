import assert from 'node:assert/strict';
import { deliverOnlineAsset, markdownToFeishuXml } from './online-delivery.mjs';

{
  const xml = markdownToFeishuXml('招聘方案', [
    '## 目标',
    '**重点**：提升转化率。',
    '- 内推',
    '- 猎头',
    '| 指标 | 目标值 |',
    '| --- | --- |',
    '| 到面率 | 60% |',
  ].join('\n'));
  assert.match(xml, /<h2>目标<\/h2>/);
  assert.match(xml, /<p><b>重点<\/b>：提升转化率。<\/p>/);
  assert.match(xml, /<ul><li>内推<\/li><li>猎头<\/li><\/ul>/);
  assert.match(xml, /<table>.*<th>指标<\/th>.*<td>到面率<\/td>.*<\/table>/s);
}

{
  const calls = [];
  const result = await deliverOnlineAsset({
    plan: { kind: 'online_document', provider: 'feishu' },
    title: '招聘方案',
    content: '# 招聘方案\n\n正文',
    runLark: async (args, options) => {
      calls.push({ args, options });
      return { ok: true, data: { document: { url: 'https://x.feishu.cn/docx/doc1' } } };
    },
  });
  assert.equal(result.url, 'https://x.feishu.cn/docx/doc1');
  assert.deepEqual(calls[0].args.slice(0, 6), [
    'docs', '+create', '--as', 'user', '--doc-format', 'xml',
  ]);
  assert.equal(calls[0].args.includes('--content'), true);
  assert.equal(calls[0].args.includes('--title'), false);
  assert.equal(calls[0].options.input, '<title>招聘方案</title>\n<p>正文</p>');
}

{
  const calls = [];
  const sheetModel = { title: '招聘看板', columns: ['渠道', '人数'], rows: [['内推', 12]] };
  const result = await deliverOnlineAsset({
    plan: { kind: 'online_spreadsheet', provider: 'feishu' },
    title: '招聘看板',
    sheetModel,
    runLark: async (args, options) => {
      calls.push({ args, options });
      return { ok: true, data: { spreadsheet: { url: 'https://x.feishu.cn/sheets/sht1' } } };
    },
  });
  assert.equal(result.url, 'https://x.feishu.cn/sheets/sht1');
  assert.deepEqual(calls[0].args.slice(0, 4), ['sheets', '+workbook-create', '--as', 'user']);
  assert.deepEqual(JSON.parse(calls[0].options.input), [['渠道', '人数'], ['内推', 12]]);
}

{
  const calls = [];
  const result = await deliverOnlineAsset({
    plan: { kind: 'online_document', provider: 'dingtalk' },
    title: '招聘方案',
    content: '# 招聘方案\n\n正文',
    dingtalkProfile: 'corp:user',
    runDws: async (args, options) => {
      calls.push({ args, options });
      if (args.includes('create')) return { success: true, nodeId: 'doc1' };
      if (args.includes('read')) return { success: true, markdown: '# 招聘方案\n\n正文' };
      throw new Error(`unexpected command: ${args.join(' ')}`);
    },
  });
  assert.equal(result.url, 'https://alidocs.dingtalk.com/i/nodes/doc1');
  assert.deepEqual(calls[0].args.slice(0, 4), ['--profile', 'corp:user', 'doc', 'create']);
  assert.equal(calls[0].options.input, '# 招聘方案\n\n正文');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes('read'), true);
  assert.equal(calls[1].args.includes('https://alidocs.dingtalk.com/i/nodes/doc1'), true);
}

{
  const calls = [];
  const result = await deliverOnlineAsset({
    plan: { kind: 'online_spreadsheet', provider: 'dingtalk' },
    title: '招聘看板',
    sheetModel: { title: '招聘看板', columns: ['渠道', '人数'], rows: [['内推', 12]] },
    dingtalkProfile: 'corp:user',
    runDws: async (args, options = {}) => {
      calls.push({ args, options });
      if (args.includes('create')) {
        return { success: true, nodeId: 'sheet1' };
      }
      if (args.includes('list')) {
        return { success: true, result: { sheets: [{ sheetId: 'tab-1', name: 'Sheet1' }] } };
      }
      if (args.includes('csv-get')) {
        return { success: true, csv: '渠道,人数\r\n内推,12' };
      }
      return { success: true };
    },
  });
  assert.equal(result.url, 'https://alidocs.dingtalk.com/i/nodes/sheet1');
  assert.equal(calls.length, 4);
  assert.equal(calls[1].args.includes('list'), true);
  assert.equal(calls[2].args.includes('csv-put'), true);
  assert.equal(calls[2].options.input, '渠道,人数\r\n内推,12');
  assert.equal(calls[3].args.includes('csv-get'), true);
  assert.equal(calls[3].args.includes('A1:B2'), true);
}

console.log('ONLINE_DELIVERY_TEST_OK');
