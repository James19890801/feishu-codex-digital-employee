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
  now: new Date('2026-08-11T10:00:00.000Z'),
  runDws: async args => {
    if (args[0] === 'minutes' && args[1] === 'list' && args[2] === 'all') {
      return {
        success: true,
        result: {
          hasMore: false,
          itemList: [{ startTime: 1786413840000, uuid: taskUuid, title: '技术需求与开发进度同步', shareUrl: minutesUrl }],
        },
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

let dailyListCalls = 0;
const dailyListArgs = [];
const retryWaits = [];
const recoveredDailyMinutes = await collectDwsMinutes({
  profile: 'corp:user',
  state: { cursor: 'old-checkpoint' },
  now: new Date('2026-08-11T10:00:00.000Z'),
  retryAttempts: 2,
  retryDelayMs: 1,
  wait: async delayMs => retryWaits.push(delayMs),
  runDws: async args => {
    if (args[0] === 'minutes' && args[1] === 'list' && args[2] === 'all') {
      dailyListCalls += 1;
      dailyListArgs.push(args);
      if (dailyListCalls === 1) return { success: true, result: { hasMore: false, itemList: [] } };
      return {
        success: true,
        result: {
          hasMore: false,
          nextToken: 'unused-final-token',
          itemList: [{
            uuid: taskUuid,
            title: '08-11 技术需求与开发进度同步',
            shareUrl: minutesUrl,
            startTimeISO: '2026-08-11T10:04:00+08:00',
          }],
        },
      };
    }
    return {
      basic: { success: true, result: { taskUuid, title: '08-11 技术需求与开发进度同步', url: minutesUrl } },
      summary: { success: true, result: { fullSummary: '会议结论：当天听记恢复成功。' } },
      keywords: { success: true, result: { keywords: ['听记', '恢复'] } },
      transcript: { success: true, result: { paragraphList: [] } },
      todos: { success: true, result: { actions: [] } },
    };
  },
});

assert.equal(recoveredDailyMinutes.records.length, 1, 'an empty first daily list must be retried instead of accepted');
assert.equal(recoveredDailyMinutes.records[0].id, taskUuid, 'the atomic list uuid must become the minutes record id');
assert.equal(recoveredDailyMinutes.records[0].locator, minutesUrl, 'the atomic list shareUrl must be retained');
assert.equal(dailyListCalls, 2, 'the empty daily read must retry once');
assert.deepEqual(retryWaits, [1]);
assert.ok(dailyListArgs[0].includes('2026-08-11T00:00:00+08:00'));
assert.ok(dailyListArgs[0].includes('2026-08-11T18:00:00+08:00'));
assert.ok(dailyListArgs[1].includes('--verbose'), 'the diagnostic retry must be verbose');
assert.ok(dailyListArgs[1].includes('--timeout'), 'the diagnostic retry must use an explicit timeout');

let detailCalls = 0;
const recoveredDetailMinutes = await collectDwsMinutes({
  profile: 'corp:user',
  now: new Date('2026-08-11T10:00:00.000Z'),
  retryAttempts: 2,
  retryDelayMs: 0,
  wait: async () => {},
  runDws: async args => {
    if (args[0] === 'minutes' && args[1] === 'list') {
      return { success: true, result: { hasMore: false, itemList: [{ uuid: taskUuid, title: '08-11 会议', shareUrl: minutesUrl }] } };
    }
    detailCalls += 1;
    if (detailCalls === 1) throw new Error('temporary detail failure');
    return {
      basic: { success: true, result: { title: '08-11 会议', url: minutesUrl } },
      summary: { success: true, result: { fullSummary: '详情第二次读取成功。' } },
      keywords: { success: true, result: { keywords: [] } },
      transcript: { success: true, result: { paragraphList: [] } },
      todos: { success: true, result: { actions: [] } },
    };
  },
});

assert.equal(detailCalls, 2, 'a transient minutes detail failure must be retried');
assert.match(recoveredDetailMinutes.records[0].text, /详情第二次读取成功/);
assert.doesNotMatch(recoveredDetailMinutes.records[0].text, /详情未读取/);

let incompleteDetailCalls = 0;
const completedDetailMinutes = await collectDwsMinutes({
  profile: 'corp:user',
  now: new Date('2026-08-11T10:00:00.000Z'),
  retryAttempts: 2,
  retryDelayMs: 0,
  wait: async () => {},
  runDws: async args => {
    if (args[0] === 'minutes' && args[1] === 'list') {
      return { success: true, result: { hasMore: false, itemList: [{ uuid: taskUuid, title: '08-11 会议', shareUrl: minutesUrl }] } };
    }
    incompleteDetailCalls += 1;
    if (incompleteDetailCalls === 1) {
      return { basic: { success: true, result: { title: '08-11 会议', url: minutesUrl } } };
    }
    return {
      basic: { success: true, result: { title: '08-11 会议', url: minutesUrl } },
      summary: { success: true, result: { fullSummary: '摘要生成完成后才能入库。' } },
      keywords: { success: true, result: { keywords: [] } },
      transcript: { success: true, result: { paragraphList: [] } },
      todos: { success: true, result: { actions: [] } },
    };
  },
});

assert.equal(incompleteDetailCalls, 2, 'metadata-only minutes detail must be retried until content is ready');
assert.match(completedDetailMinutes.records[0].text, /摘要生成完成后才能入库/);

let emptyListCalls = 0;
const emptyWaits = [];
await assert.rejects(
  collectDwsMinutes({
    profile: 'corp:user',
    now: new Date('2026-08-11T10:00:00.000Z'),
    retryAttempts: 3,
    retryDelayMs: 2,
    wait: async delayMs => emptyWaits.push(delayMs),
    runDws: async () => {
      emptyListCalls += 1;
      return { success: true, result: { hasMore: false, itemList: [] } };
    },
  }),
  /AI 听记未读取.*已尝试 3 次/,
  'a persistently empty daily list must be unread rather than successful zero activity',
);
assert.equal(emptyListCalls, 3);
assert.deepEqual(emptyWaits, [2, 2]);

let pagedListCalls = 0;
const secondTaskUuid = `${taskUuid}ff`;
const pagedMinutes = await collectDwsMinutes({
  profile: 'corp:user',
  now: new Date('2026-08-11T10:00:00.000Z'),
  retryAttempts: 1,
  wait: async () => {},
  runDws: async args => {
    if (args[0] === 'minutes' && args[1] === 'list') {
      pagedListCalls += 1;
      if (pagedListCalls === 1) {
        return { success: true, result: { hasMore: true, nextToken: 'page-2', itemList: [{ uuid: taskUuid, title: '会议 1', shareUrl: minutesUrl }] } };
      }
      assert.ok(args.includes('page-2'), 'the nextToken must be passed to the next daily page');
      return { success: true, result: { hasMore: false, itemList: [{ uuid: secondTaskUuid, title: '会议 2', shareUrl: `${minutesUrl}ff` }] } };
    }
    const id = args[args.indexOf('--id') + 1];
    return {
      basic: { success: true, result: { title: id === taskUuid ? '会议 1' : '会议 2' } },
      summary: { success: true, result: { fullSummary: `${id} 摘要` } },
      transcript: { success: true, result: { paragraphList: [] } },
      todos: { success: true, result: { actions: [] } },
    };
  },
});
assert.equal(pagedListCalls, 2);
assert.deepEqual(pagedMinutes.records.map(record => record.id), [taskUuid, secondTaskUuid]);

console.log('nightly knowledge sync tests passed');
