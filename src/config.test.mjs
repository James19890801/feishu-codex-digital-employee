import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';

assert.equal(config.semanticRepeatGuardEnabled, true);
assert.equal(config.semanticRepeatWindowMs, 30 * 60_000);
assert.equal(config.semanticRepeatMaxReplies, 2);
assert.equal(config.adaptiveDiscussionEnabled, true);
assert.equal(config.adaptiveDiscussionMaxReplies, 100);
assert.equal(config.adaptiveDiscussionLowValueLimit, 3);
assert.equal(config.adaptiveDiscussionCooldownMs, 30 * 60_000);
assert.equal(config.semanticGroupEngagementEnabled, true);
assert.equal(config.semanticGroupReplyThreshold, 0.86);
assert.equal(config.semanticGroupEntryCooldownMs, 120_000);
assert.equal(config.semanticGroupAliases.includes('AIPRO'), true);
assert.equal(typeof config.groupHostModeEnabled, 'boolean');
assert.equal(Array.isArray(config.groupHostChatIds), true);
assert.equal(config.groupHostSilenceMs, 75_000);
assert.equal(config.groupHostReplyCooldownMs, 180_000);
assert.equal(config.dailyLearningConversationLimit, 1_000);
assert.equal(typeof config.geweNewcomerWelcomeEnabled, 'boolean');
assert.equal(typeof config.geweNewcomerWelcomeGroupId, 'string');
assert.equal(typeof config.geweNewcomerWelcomeGroupName, 'string');
assert.equal(config.geweNewcomerWelcomeIntervalMs, 120_000);
assert.equal(typeof config.geweDailyBriefingGroupId, 'string');
assert.equal(typeof config.geweDailyBriefingGroupName, 'string');
assert.equal(typeof config.geweMomentsEngagementEnabled, 'boolean');
assert.equal(config.geweMomentsScanIntervalMs, 300_000);
assert.equal(config.geweMomentsMaxProactivePerDay, 20);
assert.equal(config.geweMomentsMaxRepliesPerDay, 20);
assert.equal(config.geweMomentsMaxThreadDepth, 4);
assert.equal(config.geweMomentsPostMaxAgeHours, 36);
assert.equal(typeof config.geweMomentsPublisherEnabled, 'boolean');
assert.equal(config.geweMomentsPublisherIntervalMs, 60_000);
assert.equal(config.geweMomentsPublisherMorningWindow, '10:00-12:00');
assert.equal(config.geweMomentsPublisherEveningWindow, '18:30-21:00');
assert.equal(typeof config.geweOwnerArticleSyndicationEnabled, 'boolean');
assert.deepEqual(config.geweOwnerArticlePublisherIds, [
  'gh_07e3d1422f5e',
  'BPM321GO',
  'gh_63f557f95450',
  'HuaYu_Consulting_21',
]);
assert.deepEqual(config.geweOwnerArticleWechatIds, ['fung5115']);
assert.equal(config.geweRelationshipMemoryEnabled, true);
assert.equal(config.geweRelationshipMemoryIntervalMs, 120_000);
assert.equal(config.geweRelationshipMemoryBatchSize, 10);
assert.equal(config.geweRelationshipMemoryCapsuleMaxChars, 1_200);
assert.equal(config.geweRelationshipMemoryRecallLimit, 6);

const directory = mkdtempSync(join(tmpdir(), 'aipro-config-'));
try {
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const defaultsPath = join(directory, 'group-host-defaults.json');
  const defaultsInput = { ...example, feishuEnabled: false, allowAllChats: true };
  delete defaultsInput.groupHostModeEnabled;
  delete defaultsInput.groupHostChatIds;
  delete defaultsInput.groupHostSilenceMs;
  delete defaultsInput.groupHostReplyCooldownMs;
  delete defaultsInput.geweNewcomerWelcomeEnabled;
  delete defaultsInput.geweNewcomerWelcomeGroupId;
  delete defaultsInput.geweNewcomerWelcomeGroupName;
  delete defaultsInput.geweNewcomerWelcomeIntervalMs;
  delete defaultsInput.geweDailyBriefingGroupId;
  delete defaultsInput.geweDailyBriefingGroupName;
  delete defaultsInput.geweMomentsEngagementEnabled;
  delete defaultsInput.geweMomentsScanIntervalMs;
  delete defaultsInput.geweMomentsMaxProactivePerDay;
  delete defaultsInput.geweMomentsMaxRepliesPerDay;
  delete defaultsInput.geweMomentsMaxThreadDepth;
  delete defaultsInput.geweMomentsPostMaxAgeHours;
  delete defaultsInput.geweMomentsPublisherEnabled;
  delete defaultsInput.geweMomentsPublisherIntervalMs;
  delete defaultsInput.geweMomentsPublisherMorningWindow;
  delete defaultsInput.geweMomentsPublisherEveningWindow;
  delete defaultsInput.geweOwnerArticleSyndicationEnabled;
  delete defaultsInput.geweOwnerArticlePublisherIds;
  delete defaultsInput.geweOwnerArticleWechatIds;
  writeFileSync(defaultsPath, JSON.stringify(defaultsInput));
  const defaults = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "const {config}=await import('./src/config.mjs'); console.log(JSON.stringify({enabled:config.groupHostModeEnabled,chats:config.groupHostChatIds,silence:config.groupHostSilenceMs,cooldown:config.groupHostReplyCooldownMs,welcomeEnabled:config.geweNewcomerWelcomeEnabled,welcomeGroupId:config.geweNewcomerWelcomeGroupId,welcomeGroupName:config.geweNewcomerWelcomeGroupName,welcomeInterval:config.geweNewcomerWelcomeIntervalMs,briefingGroupId:config.geweDailyBriefingGroupId,briefingGroupName:config.geweDailyBriefingGroupName,momentsEnabled:config.geweMomentsEngagementEnabled,momentsInterval:config.geweMomentsScanIntervalMs,momentsProactive:config.geweMomentsMaxProactivePerDay,momentsReplies:config.geweMomentsMaxRepliesPerDay,momentsDepth:config.geweMomentsMaxThreadDepth,momentsAge:config.geweMomentsPostMaxAgeHours,publisherEnabled:config.geweMomentsPublisherEnabled,publisherInterval:config.geweMomentsPublisherIntervalMs,publisherMorning:config.geweMomentsPublisherMorningWindow,publisherEvening:config.geweMomentsPublisherEveningWindow,ownerArticleEnabled:config.geweOwnerArticleSyndicationEnabled,ownerArticlePublishers:config.geweOwnerArticlePublisherIds,ownerArticleWechatIds:config.geweOwnerArticleWechatIds}))",
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DIGITAL_EMPLOYEE_CONFIG: defaultsPath },
    encoding: 'utf8',
  });
  assert.equal(defaults.status, 0, defaults.stderr);
  assert.deepEqual(JSON.parse(defaults.stdout), {
    enabled: false,
    chats: [],
    silence: 75_000,
    cooldown: 180_000,
    welcomeEnabled: false,
    welcomeGroupId: '',
    welcomeGroupName: '',
    welcomeInterval: 120_000,
    briefingGroupId: '',
    briefingGroupName: '',
    momentsEnabled: false,
    momentsInterval: 300_000,
    momentsProactive: 20,
    momentsReplies: 20,
    momentsDepth: 4,
    momentsAge: 36,
    publisherEnabled: false,
    publisherInterval: 60_000,
    publisherMorning: '10:00-12:00',
    publisherEvening: '18:30-21:00',
    ownerArticleEnabled: false,
    ownerArticlePublishers: [
      'gh_07e3d1422f5e', 'BPM321GO', 'gh_63f557f95450', 'HuaYu_Consulting_21',
    ],
    ownerArticleWechatIds: ['fung5115'],
  });
  for (const [field, value] of [
    ['semanticRepeatMaxReplies', 1],
    ['adaptiveDiscussionMaxReplies', 101],
    ['adaptiveDiscussionLowValueLimit', 1],
    ['adaptiveDiscussionCooldownMs', 30_000],
    ['semanticGroupReplyThreshold', 0.4],
    ['semanticGroupEntryCooldownMs', 20_000],
    ['semanticGroupAliases', ['']],
    ['groupHostChatIds', ['']],
    ['groupHostSilenceMs', 20_000],
    ['groupHostReplyCooldownMs', 30_000],
    ['dailyLearningConversationLimit', 0],
    ['geweNewcomerWelcomeIntervalMs', 10_000],
    ['geweMomentsScanIntervalMs', 59_000],
    ['geweMomentsMaxProactivePerDay', 0],
    ['geweMomentsMaxRepliesPerDay', 0],
    ['geweMomentsMaxThreadDepth', 0],
    ['geweMomentsPostMaxAgeHours', 0],
    ['geweMomentsPublisherIntervalMs', 30_000],
    ['geweMomentsPublisherMorningWindow', '12:00-10:00'],
    ['geweMomentsPublisherEveningWindow', 'not-a-window'],
    ['geweOwnerArticlePublisherIds', ['']],
    ['geweOwnerArticleWechatIds', ['']],
    ['geweRelationshipMemoryIntervalMs', 30_000],
    ['geweRelationshipMemoryBatchSize', 0],
    ['geweRelationshipMemoryCapsuleMaxChars', 200],
    ['geweRelationshipMemoryRecallLimit', 0],
  ]) {
    const invalidPath = join(directory, `${field}.json`);
    writeFileSync(invalidPath, JSON.stringify({ ...example, [field]: value }));
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('./src/config.mjs')",
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DIGITAL_EMPLOYEE_CONFIG: invalidPath },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, field);
    assert.match(result.stderr, new RegExp(field));
  }
  const enabledWithoutTargetPath = join(directory, 'gewe-welcome-missing-target.json');
  writeFileSync(enabledWithoutTargetPath, JSON.stringify({
    ...example,
    feishuEnabled: false,
    allowAllChats: true,
    geweNewcomerWelcomeEnabled: true,
    geweNewcomerWelcomeGroupId: '',
    geweNewcomerWelcomeGroupName: '',
  }));
  const enabledWithoutTarget = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "await import('./src/config.mjs')",
  ], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DIGITAL_EMPLOYEE_CONFIG: enabledWithoutTargetPath },
    encoding: 'utf8',
  });
  assert.notEqual(enabledWithoutTarget.status, 0);
  assert.match(enabledWithoutTarget.stderr, /geweNewcomerWelcomeGroup/);

  for (const invalidBriefing of [
    { geweDailyBriefingGroupId: '53822548488@chatroom', geweDailyBriefingGroupName: '' },
    { geweDailyBriefingGroupId: '', geweDailyBriefingGroupName: 'AI流程与组织变革交流二群' },
    { geweDailyBriefingGroupId: 'not-a-chatroom', geweDailyBriefingGroupName: 'AI流程与组织变革交流二群' },
  ]) {
    const invalidPath = join(directory, `invalid-briefing-${Math.random()}.json`);
    writeFileSync(invalidPath, JSON.stringify({
      ...example,
      feishuEnabled: false,
      allowAllChats: true,
      ...invalidBriefing,
    }));
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('./src/config.mjs')",
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DIGITAL_EMPLOYEE_CONFIG: invalidPath },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /geweDailyBriefingGroup/);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('CONFIG_TEST_OK');
