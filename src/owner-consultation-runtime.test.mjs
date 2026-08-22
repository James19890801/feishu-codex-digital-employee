import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexSource = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');
const configSource = readFileSync(new URL('./config.mjs', import.meta.url), 'utf8');
const exampleConfig = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
const distributionConfig = JSON.parse(readFileSync(new URL('../config.distribution.json', import.meta.url), 'utf8'));

assert.match(indexSource, /OwnerConsultationCoordinator/);
assert.match(indexSource, /parseOwnerConsultationDecision/);
assert.match(indexSource, /ownerConsultationCoordinator\.handleOwnerResponse/);
assert.match(indexSource, /ownerConsultationCoordinator\.start/);
assert.match(indexSource, /metadata\.quotedMessage\?\.messageId/);
assert.match(indexSource, /ownerConsultationCoordinator\.processDue/);
assert.match(indexSource, /geweOwnerWxids/);

assert.match(configSource, /geweOwnerConsultationEnabled/);
assert.match(configSource, /geweOwnerConsultationReminderMs/);
assert.match(configSource, /geweOwnerConsultationTtlMs/);
assert.deepEqual(exampleConfig.geweOwnerWxids, ['fung5115']);
assert.equal(exampleConfig.geweOwnerConsultationEnabled, true);
assert.equal(exampleConfig.geweOwnerConsultationReminderMs, 14_400_000);
assert.equal(exampleConfig.geweOwnerConsultationTtlMs, 86_400_000);
assert.deepEqual(distributionConfig.geweOwnerWxids, ['fung5115']);
assert.equal(distributionConfig.geweOwnerConsultationEnabled, true);

console.log('OWNER_CONSULTATION_RUNTIME_TEST_OK');
