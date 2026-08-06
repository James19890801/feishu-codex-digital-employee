import assert from 'node:assert/strict';
import { formatMulticaLiveProgress } from './multica-live-progress.mjs';

const result = formatMulticaLiveProgress({
  identifier: 'MYS-8', title: '制定报名提升策略',
}, [{ seq: 1, type: 'thinking', content: 'private chain of thought' }, {
  seq: 2, type: 'text', content: '已完成调研，正在生成 PDF。',
}, {
  seq: 3, type: 'tool_use', tool: 'exec_command', input: { command: 'secret command' },
}, {
  seq: 4, type: 'text', content: 'PDF 已上传，正在提交。',
}]);

assert.equal(result.maxSeq, 4);
assert.match(result.text, /MYS-8/);
assert.match(result.text, /正在生成 PDF/);
assert.match(result.text, /PDF 已上传/);
assert.doesNotMatch(result.text, /private chain of thought/);
assert.doesNotMatch(result.text, /secret command/);

assert.deepEqual(formatMulticaLiveProgress({ identifier: 'MYS-8' }, [
  { seq: 5, type: 'thinking', content: 'hidden' },
]), { text: '', maxSeq: 5 });

console.log('MULTICA_LIVE_PROGRESS_TEST_OK');
