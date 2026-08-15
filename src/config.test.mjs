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
  writeFileSync(defaultsPath, JSON.stringify(defaultsInput));
  const defaults = spawnSync(process.execPath, [
    '--input-type=module',
    '--eval',
    "const {config}=await import('./src/config.mjs'); console.log(JSON.stringify({enabled:config.groupHostModeEnabled,chats:config.groupHostChatIds,silence:config.groupHostSilenceMs,cooldown:config.groupHostReplyCooldownMs,welcomeEnabled:config.geweNewcomerWelcomeEnabled,welcomeGroupId:config.geweNewcomerWelcomeGroupId,welcomeGroupName:config.geweNewcomerWelcomeGroupName,welcomeInterval:config.geweNewcomerWelcomeIntervalMs,briefingGroupId:config.geweDailyBriefingGroupId,briefingGroupName:config.geweDailyBriefingGroupName}))",
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
