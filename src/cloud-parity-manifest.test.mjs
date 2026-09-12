import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildParityManifest } from './cloud-parity-manifest.mjs';

const input = {
  config: {
    allowAllChats: false,
    authorizedChatIds: ['chat-b', 'chat-a'],
    geweMentionNames: ['小詹'],
    geweMomentsInteractionBlocklist: ['blocked-user'],
    geweDailyBriefingGroupId: 'briefing-group',
    geweNewcomerWelcomeGroupId: 'welcome-group',
    geweMomentsPublisherMorningWindow: '09:00-10:00',
    geweMomentsPublisherEveningWindow: '18:00-19:00',
    groupHostChatIds: ['group-1'],
    dingtalkProfile: 'private-local-profile',
    geweKeychainService: 'private-keychain-name',
    ownerContactPhone: 'private-phone',
    codexBin: '/Users/owner/bin/codex',
  },
  persona: '# 人设\n友善而准确。',
  bible: '# 规则\n真人接管优先。',
  instructions: '# 运行规则\n群聊被 @ 必回复。',
  state: {
    relationship_profile: [{ person_id: 'person-1', summary: '喜欢讨论流程', tone: '轻松', secret_token: 'never-copy' }],
    relationship_fact: [{ fact_id: 'fact-1', person_id: 'person-1', content: '上次讨论流程', status: 'active' }],
    owner_consultation: [{ id: 'approval-1', decision: 'pending', status: 'pending', source_message_id: 'msg-1' }],
    settings: [{ scope: 'auth', key: 'token', value: 'never-copy' },
      { scope: 'chat-1', key: 'human_takeover', value: '{"pausedUntilMs":1800000000000}', updated_at: 'today' },
      { scope: 'chat-2', key: 'semantic_group_reply', value: '{"lastReplyAt":10}' }],
    rate_limit: [{ subject: 'chat-1', count: 2, window_start_ms: 100, updated_at: 'today' }],
    inbound_message: [{ message_id: 'old', payload: 'do-not-copy-whole-queue' }],
  },
};

test('exports persona, rules, allow and deny lists, and selected continuity state', () => {
  const manifest = buildParityManifest(input);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.sections.persona.data, input.persona);
  assert.equal(manifest.sections.bible.data, input.bible);
  assert.equal(manifest.sections.instructions.data, input.instructions);
  assert.deepEqual(manifest.sections.config.data.authorizedChatIds, ['chat-b', 'chat-a']);
  assert.deepEqual(manifest.sections.config.data.geweMomentsInteractionBlocklist, ['blocked-user']);
  assert.equal(manifest.sections.config.data.geweDailyBriefingGroupId, 'briefing-group');
  assert.equal(manifest.sections.config.data.geweNewcomerWelcomeGroupId, 'welcome-group');
  assert.equal(manifest.sections.config.data.geweMomentsPublisherMorningWindow, '09:00-10:00');
  assert.equal(manifest.sections.state.data.relationship_profile[0].summary, '喜欢讨论流程');
  assert.equal(manifest.sections.state.data.owner_consultation[0].status, 'pending');
  assert.deepEqual(manifest.sections.state.data.settings.map(row => row.key),
    ['human_takeover', 'semantic_group_reply']);
  assert.equal(manifest.sections.state.data.rate_limit[0].count, 2);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  assert.match(manifest.sections.config.digest, /^[a-f0-9]{64}$/);
});

test('never exports credential configuration, unknown state columns or whole inbox', () => {
  const serialized = JSON.stringify(buildParityManifest(input));
  for (const forbidden of ['private-local-profile', 'private-keychain-name', 'private-phone',
    '/Users/owner/bin/codex', 'never-copy', 'do-not-copy-whole-queue']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('digests are deterministic across input object key order', () => {
  const first = buildParityManifest(input);
  const second = buildParityManifest({
    ...input,
    config: Object.fromEntries(Object.entries(input.config).reverse()),
    state: Object.fromEntries(Object.entries(input.state).reverse()),
  });
  assert.equal(first.digest, second.digest);
});

test('rejects apparent credentials inside freeform policy documents', () => {
  assert.throws(() => buildParityManifest({ ...input, persona: 'Bearer test-secret' }), /secret/i);
});

test('a real-sized relationship history fits within the bounded manifest', () => {
  const manifest = buildParityManifest({ state: {
    relationship_episode: [{ event_id: 'long-history', content: 'x'.repeat(9 * 1024 * 1024) }],
  } });
  assert.ok(manifest.sections.state.bytes > 8 * 1024 * 1024);
});
