import assert from 'node:assert/strict';
import {
  buildMailKql,
  escapeKqlValue,
  isMailCancellation,
  isMailConfirmation,
  parseMailIntent,
  parseMailWriteDraft,
} from './mail-intent.mjs';

const now = new Date('2026-08-05T03:00:00.000Z');

assert.deepEqual(
  parseMailIntent('看看今天未读的收件箱邮件', { now }),
  {
    kind: 'search', selection: null, draft: null, limit: 10,
    filters: { folderId: 2, isRead: false, after: '2026-08-04T16:00:00.000Z' },
  },
);

assert.deepEqual(
  parseMailIntent('最近 50 封已发送邮件', { now }),
  {
    kind: 'search', selection: null, draft: null, limit: 30,
    filters: { folderId: 1 },
  },
);

assert.deepEqual(
  parseMailIntent('查张三发的主题包含「项目 进展」并且带附件的邮件', { now }),
  {
    kind: 'search', selection: null, draft: null, limit: 10,
    filters: { folderId: 2, hasAttachments: true, from: '张三', subject: '项目 进展' },
  },
);

assert.deepEqual(
  parseMailIntent('查正文包含：故障复盘 的邮件', { now }),
  {
    kind: 'search', selection: null, draft: null, limit: 10,
    filters: { folderId: 2, body: '故障复盘' },
  },
);

assert.deepEqual(parseMailIntent('打开第 2 封邮件', { now }), {
  kind: 'open', selection: 2, draft: null, limit: 10, filters: {},
});

assert.equal(
  buildMailKql({ folderId: 2, isRead: false, subject: '项目 进展' }),
  'folderId:2 AND isRead:false AND subject:"项目 进展"',
);
assert.equal(
  buildMailKql({ after: '2026-08-04T16:00:00.000Z', from: 'alice@example.com' }),
  'date>2026-08-04T16:00:00.000Z AND from:alice@example.com',
);
assert.equal(escapeKqlValue('项目 进展'), '"项目 进展"');
assert.equal(escapeKqlValue('a"b\\c'), '"a\\"b\\\\c"');
assert.equal(escapeKqlValue('AND'), '"AND"');
assert.throws(() => escapeKqlValue('x\nOR folderId:6'), /control/i);

assert.deepEqual(
  parseMailWriteDraft('给 张三 发邮件，抄送：李四，主题：周报，正文：本周完成 A'),
  {
    operation: 'send', selection: null, recipient: '张三', cc: ['李四'],
    subject: '周报', content: '本周完成 A', note: '',
  },
);
assert.deepEqual(
  parseMailWriteDraft('回复第 2 封，正文：已收到'),
  {
    operation: 'reply', selection: 2, recipient: '', cc: [],
    subject: '', content: '已收到', note: '',
  },
);
assert.deepEqual(
  parseMailWriteDraft('回复全部第 3 封，正文：感谢大家'),
  {
    operation: 'reply_all', selection: 3, recipient: '', cc: [],
    subject: '', content: '感谢大家', note: '',
  },
);
assert.deepEqual(
  parseMailWriteDraft('转发第 1 封给 李四，附言：请查看'),
  {
    operation: 'forward', selection: 1, recipient: '李四', cc: [],
    subject: '', content: '', note: '请查看',
  },
);

assert.equal(parseMailIntent('给 张三 发邮件，主题：周报，正文：完成', { now }).kind, 'send');
assert.equal(parseMailIntent('回复第 2 封，正文：收到', { now }).kind, 'reply');
assert.equal(parseMailIntent('转发第 1 封给 李四，附言：看看', { now }).kind, 'forward');
assert.equal(parseMailIntent('帮我看看项目', { now }).kind, null);

for (const value of ['确认', '确认发送。', '发送']) assert.equal(isMailConfirmation(value), true);
for (const value of ['取消', '不发了！', '算了']) assert.equal(isMailCancellation(value), true);
assert.equal(isMailConfirmation('确认创建日程'), false);
assert.equal(isMailCancellation('取消日程'), false);

console.log('MAIL_INTENT_TEST_OK');
