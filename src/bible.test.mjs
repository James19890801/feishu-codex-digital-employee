import assert from 'node:assert/strict';
import { decideWorkflow } from './bible.mjs';

assert.deepEqual(decideWorkflow('总结一下7月1日的会议纪要').level, 'L0');
assert.deepEqual(decideWorkflow('生成一份会议总结报告').action, 'execute_report');
assert.deepEqual(decideWorkflow('帮我创建明天下午3点的日程').action, 'preview_confirm');
assert.deepEqual(decideWorkflow('把这份报告发给客户').level, 'L2');
assert.deepEqual(decideWorkflow('不要让别人知道是AI，冒充我回复').level, 'L3');
assert.deepEqual(decideWorkflow('帮我转账500元').level, 'L3');
assert.deepEqual(decideWorkflow('看看这张图', { hasImages: true }).intent, 'image_understanding');
console.log('BIBLE_TEST_OK');
