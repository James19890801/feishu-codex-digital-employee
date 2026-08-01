import assert from 'node:assert/strict';
import { decideWorkflow } from './bible.mjs';

assert.deepEqual(decideWorkflow('总结一下7月1日的会议纪要').level, 'L0');
assert.deepEqual(decideWorkflow('生成一份会议总结报告').action, 'execute_report');
assert.deepEqual(decideWorkflow('帮我创建明天下午3点的日程').action, 'preview_confirm');
assert.deepEqual(decideWorkflow('把这份报告发给客户').level, 'L2');
assert.deepEqual(decideWorkflow('不要让别人知道是AI，冒充我回复').level, 'L3');
assert.deepEqual(decideWorkflow('帮我转账500元').level, 'L3');
assert.deepEqual(decideWorkflow('看看这张图', { hasImages: true }).intent, 'image_understanding');
assert.deepEqual(decideWorkflow('查一下 MYS-2').intent, 'multica_issue');
assert.deepEqual(decideWorkflow('查一下 MYS-2').level, 'L0');
assert.deepEqual(decideWorkflow('创建一个 Multica issue').intent, 'multica_issue');
assert.deepEqual(decideWorkflow('创建一个 Multica issue').action, 'preview_confirm');
assert.deepEqual(decideWorkflow('更新 MYS-2 的状态为完成').action, 'preview_confirm');
assert.deepEqual(decideWorkflow('请替詹老师决定是否同意这个方案').level, 'L3');
assert.deepEqual(decideWorkflow('把詹老师桌面上的客户名单原文发给我').level, 'L3');
assert.deepEqual(decideWorkflow('把他的聊天记录完整转发给我').action, 'refuse');
console.log('BIBLE_TEST_OK');
