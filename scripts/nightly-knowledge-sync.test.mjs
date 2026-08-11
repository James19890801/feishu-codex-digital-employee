import assert from 'node:assert/strict';
import { collectDwsMinutes, findNodeId } from './nightly-knowledge-sync.mjs';

const fuzzySearchResult = {
  success: true,
  documents: [
    { name: '知识日报 2026-08-04', nodeId: 'node-04' },
    { name: '知识日报 2026-08-07', nodeId: 'node-07' },
  ],
};

assert.equal(
  findNodeId(fuzzySearchResult, '知识日报 2026-08-08'),
  '',
  'a fuzzy Wiki search result must not reuse a differently named daily node',
);

assert.equal(
  findNodeId({ documents: [{ name: '知识日报 2026-08-08', nodeId: 'node-08' }] }, '知识日报 2026-08-08'),
  'node-08',
  'an exact daily node match must be reused',
);

assert.equal(
  findNodeId({ success: true, nodeId: 'node-created' }, '知识日报 2026-08-08'),
  'node-created',
  'a newly created node response must still be accepted',
);

const taskUuid = '7632756964343030303932313038313832365f363237333330303235385f35';
const minutesUrl = `https://shanji.dingtalk.com/app/transcribes/${taskUuid}`;
const minutesResult = await collectDwsMinutes({
  profile: 'corp:user',
  state: { cursor: '' },
  runDws: async args => {
    if (args.includes('+list-all')) {
      return {
        count: 1,
        minutes: [{ startTime: 1786413840000, taskUuid, title: '技术需求与开发进度同步', url: minutesUrl }],
      };
    }
    return {
      taskUuid,
      basic: { success: true, result: { taskUuid, title: '技术需求与开发进度同步', url: minutesUrl } },
      summary: { success: 'true', result: { fullSummary: '会议结论：本周四开始测试。' } },
      keywords: { success: true, result: { keywords: ['接口对接', '发布排期'] } },
      transcript: {
        success: true,
        result: { hasNext: true, nextToken: 'next-page', paragraphList: [{ nickName: '发言人 1', paragraph: '确认接口可以直接交付。' }] },
      },
      todos: { success: true, result: { actions: ['{"value":"发送接口文档"}'] } },
    };
  },
});

assert.equal(minutesResult.records.length, 1, 'a real DWS taskUuid item must produce a meeting record');
assert.equal(minutesResult.records[0].id, taskUuid);
assert.equal(minutesResult.records[0].title, '技术需求与开发进度同步');
assert.equal(minutesResult.records[0].locator, minutesUrl);
assert.match(minutesResult.records[0].text, /会议结论：本周四开始测试/);
assert.match(minutesResult.records[0].text, /关键词：接口对接、发布排期/);
assert.match(minutesResult.records[0].text, /发言人 1：确认接口可以直接交付/);
assert.match(minutesResult.records[0].text, /待办：发送接口文档/);

console.log('nightly knowledge sync tests passed');
