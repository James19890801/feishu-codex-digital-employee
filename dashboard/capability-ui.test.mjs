import assert from 'node:assert/strict';
import { formatChannelCapabilities } from './capability-ui.js';

assert.equal(formatChannelCapabilities(null, 'zh'), '');
assert.equal(formatChannelCapabilities({ capabilities: {
  text: true, image: true, audio: false, link: true,
} }, 'zh'), '文字 ✓ · 图片 ✓ · 语音 × · 链接 ✓');
assert.equal(formatChannelCapabilities({ capabilities: {
  text: true, image: false, audio: false, link: true,
} }, 'en'), 'Text ✓ · Image × · Audio × · Link ✓');

console.log('DASHBOARD_CAPABILITY_UI_TEST_OK');
