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
assert.equal(translate('en', 'brandSubtitle'), 'Your identity, intelligently present.');
assert.equal(translate('zh', 'brandSubtitle'), '让智能，以你的身份在场。');
assert.equal(translate('en', 'brandName'), 'AIPRO');
assert.equal(translate('zh', 'brandName'), 'AIPRO');
assert.match(translate('en', 'pageTitle'), /^AIPRO · Your identity, intelligently present\.$/);
assert.match(translate('zh', 'pageTitle'), /^AIPRO · 让智能，以你的身份在场。$/);
assert.match(translate('en', 'activationLead'), /authorized social identity/);
assert.match(translate('zh', 'activationTrust'), /身份始终属于你/);
assert.equal(translate('en', 'generateTenInvites'), 'Generate 10 codes');
assert.equal(translate('zh', 'contactDeveloper'), '联系开发者');
assert.equal(translate('en', 'contactDeveloperMeta'), 'Invitation & support');
assert.equal(translate('zh', 'contactDeveloperMeta'), '邀请码与支持');
assert.equal(translate('en', 'brandCampaignTitle'), 'Your identity, intelligently present.');
assert.equal(translate('zh', 'brandCampaignTitle'), '让智能，以你的身份在场。');
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
