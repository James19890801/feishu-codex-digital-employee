import assert from 'node:assert/strict';
import {
  channelSubmitText,
  normalizeLocale,
  runtimeStatusText,
  supportedLocales,
  translate,
} from './i18n.js';

assert.deepEqual(supportedLocales, ['en', 'zh']);
assert.equal(normalizeLocale(), 'en');
assert.equal(normalizeLocale('en-US'), 'en');
assert.equal(normalizeLocale('zh-CN'), 'zh');
assert.equal(translate('en', 'brandSubtitle'), 'AI operations powered by a real human identity');
assert.equal(translate('zh', 'brandSubtitle'), '基于真人身份运行的 AI 数字人平台');
assert.equal(translate('en', 'openSourceCredit'), 'Developed by Zhao Yingzhi & James Feng');
assert.match(translate('zh', 'openSourceCredit'), /赵颖知.*James Feng/);
assert.equal(translate('en', 'consumers', { count: 2 }), '2 consumer(s)');
assert.equal(translate('zh', 'consumers', { count: 2 }), '2 个消费者');
assert.equal(translate('en', 'missing-key'), 'missing-key');
assert.equal(runtimeStatusText('en', { available: true }), 'Online');
assert.equal(runtimeStatusText('zh', { installed: true, available: false }), '仅检测到应用');
assert.equal(channelSubmitText('en', { protected: true }), 'PRIMARY PATH PROTECTED');
assert.equal(channelSubmitText('zh', { enabled: false }), '配置保存');

console.log('DASHBOARD_I18N_TEST_OK');
