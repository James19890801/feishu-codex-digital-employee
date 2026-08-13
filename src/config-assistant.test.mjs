import assert from 'node:assert/strict';

const assistant = await import('./config-assistant.mjs').catch(() => ({}));
const fakeApiToken = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');

assert.equal(
  typeof assistant.createChangePlan,
  'function',
  'createChangePlan must exist before configuration changes can be planned',
);
assert.equal(typeof assistant.applyChangePlan, 'function');
assert.equal(typeof assistant.parsePlannerOutput, 'function');
assert.equal(typeof assistant.publicConfiguration, 'function');
assert.equal(typeof assistant.validateAssistantRequest, 'function');
assert.equal(typeof assistant.buildPlannerPrompt, 'function');
assert.equal(typeof assistant.assertPlanMatchesDocuments, 'function');

const documents = {
  config: {
    feishuAppId: 'cli_aaaaaaaaaaaaaaaa',
    ownerOpenId: 'ou_owner123',
    keychainService: 'codex-feishu-digital-employee',
    authorizedChatIds: [],
    allowAllChats: true,
    ownerContactPhone: '010-0000-0000',
    digitalTwinLabel: '',
    eventTransport: 'lark-cli',
    pollIntervalMs: 5000,
    pollOverlapMs: 180000,
    pollInitialLookbackMs: 900000,
    pollMaxCatchupMs: 86400000,
    pollWindowMs: 900000,
    maxConcurrentReplies: 2,
    larkCliTimeoutMs: 45000,
    codexTimeoutMs: 120000,
    helperTimeoutMs: 30000,
    rateLimitWindowMs: 300000,
    rateLimitMaxMessages: 10,
    semanticGroupEngagementEnabled: true,
    semanticGroupReplyThreshold: 0.86,
    semanticGroupEntryCooldownMs: 120000,
    semanticGroupAliases: ['AIPRO', '詹老师助理'],
    dashboardPort: 17655,
    codexBin: '/Applications/ChatGPT.app/Contents/Resources/codex',
    codexModel: 'gpt-5.6-terra',
    codexProxyUrl: '',
    larkCli: '',
    nodeBin: '',
    pythonBin: '',
    aiRuntime: 'auto',
    dingtalkEnabled: false,
    dingtalkProfile: '',
    wecomEnabled: false,
    wecomBotId: '',
    geweEnabled: false,
    geweAppId: '',
    gewePublicCallbackBaseUrl: '',
    geweMentionNames: [],
  },
  persona: '# Persona\n\n- Keep replies concise.\n',
  bible: '# Bible\n\n- Never make payments.\n',
  knowledgeCatalog: [],
};

const safePlan = assistant.createChangePlan({
  summary: 'Speed up message polling',
  answer: 'I will reduce the polling interval to three seconds.',
  changes: [{
    target: 'config',
    key: 'pollIntervalMs',
    value: 3000,
    reason: 'Faster discovery of new messages',
  }],
}, documents, { id: 'plan-safe', now: '2026-07-30T00:00:00.000Z' });

assert.equal(safePlan.confirmationLevel, 'single');
assert.equal(safePlan.changes[0].before, 5000);
assert.equal(safePlan.changes[0].after, 3000);

const multicaPlan = assistant.createChangePlan({
  summary: 'Enable Multica integration',
  changes: [{
    target: 'config',
    key: 'multicaEnabled',
    value: true,
  }, {
    target: 'config',
    key: 'multicaSyncIntervalMs',
    value: 10000,
  }],
}, documents);
assert.equal(multicaPlan.confirmationLevel, 'double');
assert.equal(multicaPlan.changes[0].after, true);

const semanticEngagementPlan = assistant.createChangePlan({
  summary: 'Disable semantic group engagement',
  changes: [{
    target: 'config',
    key: 'semanticGroupEngagementEnabled',
    value: false,
  }],
}, documents);
assert.equal(semanticEngagementPlan.confirmationLevel, 'single');
assert.equal(semanticEngagementPlan.changes[0].after, false);

const contactPlan = assistant.createChangePlan({
  summary: 'Update the owner handoff phone',
  changes: [{
    target: 'config',
    key: 'ownerContactPhone',
    value: '010-0000-0001',
  }],
}, documents);
assert.equal(contactPlan.confirmationLevel, 'double');
assert.equal(contactPlan.changes[0].after, '010-0000-0001');
assert.throws(() => assistant.createChangePlan({
  summary: 'Reject an invalid phone',
  changes: [{
    target: 'config',
    key: 'ownerContactPhone',
    value: 'call-me-with-javascript',
  }],
}, documents), /phone/i);

const runtimePlan = assistant.createChangePlan({
  summary: 'Switch AI runtime',
  changes: [{
    target: 'config',
    key: 'aiRuntime',
    value: 'qoder',
    reason: 'Use the locally available Qoder CLI',
  }],
}, documents);
assert.equal(runtimePlan.confirmationLevel, 'double');
assert.equal(runtimePlan.changes[0].after, 'qoder');
assert.throws(
  () => assistant.createChangePlan({
    summary: 'Unsupported runtime',
    changes: [{
      target: 'config',
      key: 'aiRuntime',
      value: 'unknown-agent',
    }],
  }, documents),
  /aiRuntime must be one of/i,
);

const channelPlan = assistant.createChangePlan({
  summary: 'Enable both additional IM channels',
  changes: [{
    target: 'config',
    key: 'dingtalkEnabled',
    value: true,
  }, {
    target: 'config',
    key: 'wecomEnabled',
    value: true,
  }, {
    target: 'config',
    key: 'wecomBotId',
    value: 'bot-aipro',
  }],
}, documents);
assert.equal(channelPlan.confirmationLevel, 'double');
assert.deepEqual(channelPlan.changes.map(change => change.key), [
  'dingtalkEnabled',
  'wecomEnabled',
  'wecomBotId',
]);

const wechatPlan = assistant.createChangePlan({
  summary: 'Configure personal WeChat through GeWe',
  changes: [{
    target: 'config',
    key: 'geweAppId',
    value: 'wx_device_123',
  }, {
    target: 'config',
    key: 'gewePublicCallbackBaseUrl',
    value: 'https://aipro.example.com',
  }, {
    target: 'config',
    key: 'geweEnabled',
    value: true,
  }, {
    target: 'config',
    key: 'geweCallbackPort',
    value: 17656,
  }, {
    target: 'config',
    key: 'geweMentionNames',
    value: ['James'],
  }],
}, documents);
assert.equal(wechatPlan.confirmationLevel, 'double');
assert.deepEqual(wechatPlan.changes.map(change => change.key), [
  'geweAppId',
  'gewePublicCallbackBaseUrl',
  'geweEnabled',
  'geweCallbackPort',
  'geweMentionNames',
]);
assert.throws(() => assistant.createChangePlan({
  summary: 'Reject plaintext GeWe token',
  changes: [{
    target: 'config',
    key: 'geweToken',
    value: 'gw_live_this_must_never_be_stored',
  }],
}, documents), /cannot be changed/i);

const sensitivePlan = assistant.createChangePlan({
  summary: 'Restrict message scope',
  changes: [{
    target: 'config',
    key: 'allowAllChats',
    value: false,
    reason: 'Use an explicit chat list',
  }, {
    target: 'config',
    key: 'authorizedChatIds',
    value: ['oc_chat123'],
    reason: 'Allow only one chat',
  }],
}, documents, { id: 'plan-sensitive', now: '2026-07-30T00:00:00.000Z' });

assert.equal(sensitivePlan.confirmationLevel, 'double');

assert.throws(() => assistant.createChangePlan({
  summary: 'Change the account owner',
  changes: [{
    target: 'config',
    key: 'ownerOpenId',
    value: 'ou_attacker',
  }],
}, documents), /cannot be changed/i);

assert.throws(() => assistant.createChangePlan({
  summary: 'Set an invalid polling interval',
  changes: [{
    target: 'config',
    key: 'pollIntervalMs',
    value: 100,
  }],
}, documents), /pollIntervalMs/i);

assert.throws(() => assistant.createChangePlan({
  summary: 'Store a secret in Persona',
  changes: [{
    target: 'persona',
    content: `API token: ${fakeApiToken}`,
  }],
}, documents), /credential/i);

const personaPlan = assistant.createChangePlan({
  summary: 'Use shorter replies',
  changes: [{
    target: 'persona',
    content: '# Persona\n\n- Reply in no more than three sentences.\n',
    reason: 'Keep routine responses short',
  }],
}, documents, { id: 'plan-persona', now: '2026-07-30T00:00:00.000Z' });

assert.equal(personaPlan.confirmationLevel, 'single');
const updatedDocuments = assistant.applyChangePlan(documents, personaPlan);
assert.match(updatedDocuments.persona, /three sentences/);
assert.equal(documents.persona, '# Persona\n\n- Keep replies concise.\n');

assert.doesNotThrow(() => assistant.assertPlanMatchesDocuments(documents, safePlan));
assert.throws(
  () => assistant.assertPlanMatchesDocuments({
    ...documents,
    config: { ...documents.config, pollIntervalMs: 4000 },
  }, safePlan),
  /stale/i,
);

const biblePlan = assistant.createChangePlan({
  summary: 'Require confirmation for publishing',
  changes: [{
    target: 'bible',
    content: '# Bible\n\n- Publishing always requires owner confirmation.\n',
  }],
}, documents);
assert.equal(biblePlan.confirmationLevel, 'double');

const emptyPlan = assistant.createChangePlan({
  summary: 'Explain the current configuration',
  answer: 'Polling currently runs every five seconds.',
  changes: [],
}, documents);
assert.equal(emptyPlan.confirmationLevel, 'none');
assert.deepEqual(emptyPlan.changes, []);

assert.deepEqual(
  assistant.parsePlannerOutput('Result:\n```json\n{"summary":"Test","changes":[]}\n```'),
  { summary: 'Test', changes: [] },
);

const publicConfig = assistant.publicConfiguration(documents.config);
assert.equal(publicConfig.pollIntervalMs, 5000);
assert.equal(publicConfig.allowAllChats, true);
assert.equal('feishuAppId' in publicConfig, false);
assert.equal('ownerOpenId' in publicConfig, false);
assert.equal('codexBin' in publicConfig, false);
assert.equal(publicConfig.aiRuntime, 'auto');
assert.equal(publicConfig.dingtalkEnabled, false);
assert.equal(publicConfig.wecomEnabled, false);
assert.equal(publicConfig.wecomBotId, '');
assert.equal(publicConfig.semanticGroupEngagementEnabled, true);
assert.equal(publicConfig.semanticGroupReplyThreshold, 0.86);
assert.deepEqual(publicConfig.semanticGroupAliases, ['AIPRO', '詹老师助理']);

assert.deepEqual(
  assistant.effectivePublicConfiguration(
    { pollIntervalMs: 5000, allowAllChats: false, ownerOpenId: 'ou_hidden' },
    { allowAllChats: true, feishuAppId: 'cli_hidden' },
  ),
  { pollIntervalMs: 5000, allowAllChats: true },
);

assert.equal(assistant.validateAssistantRequest('Make routine replies shorter.'), 'Make routine replies shorter.');
assert.throws(
  () => assistant.validateAssistantRequest(`Use token ${fakeApiToken}`),
  /credential/i,
);
assert.throws(
  () => assistant.validateAssistantRequest('gewe-token=abcdefghijklmnopqrstuvwxyz123456'),
  /credential/i,
);
assert.throws(
  () => assistant.validateAssistantRequest('x'.repeat(5000)),
  /too long/i,
);

const plannerPrompt = assistant.buildPlannerPrompt({
  request: 'Make routine replies shorter.',
  documents,
});
assert.match(plannerPrompt, /JSON only/i);
assert.match(plannerPrompt, /pollIntervalMs/);
assert.match(plannerPrompt, /Keep replies concise/);
assert.match(plannerPrompt, /Never make payments/);
assert.doesNotMatch(plannerPrompt, /cli_aaaaaaaaaaaaaaaa/);
assert.doesNotMatch(plannerPrompt, /ou_owner123/);
assert.doesNotMatch(plannerPrompt, /codex-feishu-digital-employee/);

console.log('CONFIG_ASSISTANT_TEST_OK');
