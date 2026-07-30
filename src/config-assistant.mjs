import { isDeepStrictEqual } from 'node:util';

const CONFIG_RULES = {
  allowAllChats: { type: 'boolean', risk: 'double' },
  authorizedChatIds: { type: 'chatIds', risk: 'double' },
  digitalTwinLabel: { type: 'string', maxLength: 100, risk: 'single' },
  eventTransport: { type: 'enum', values: ['lark-cli', 'sdk'], risk: 'double' },
  pollIntervalMs: { type: 'integer', min: 1000, max: 60000, risk: 'single' },
  pollOverlapMs: { type: 'integer', min: 60000, max: 3600000, risk: 'single' },
  pollInitialLookbackMs: { type: 'integer', min: 60000, max: 86400000, risk: 'single' },
  pollMaxCatchupMs: { type: 'integer', min: 60000, max: 7 * 86400000, risk: 'single' },
  pollWindowMs: { type: 'integer', min: 60000, max: 3600000, risk: 'single' },
  maxConcurrentReplies: { type: 'integer', min: 1, max: 4, risk: 'single' },
  larkCliTimeoutMs: { type: 'integer', min: 5000, max: 180000, risk: 'single' },
  codexTimeoutMs: { type: 'integer', min: 10000, max: 300000, risk: 'single' },
  helperTimeoutMs: { type: 'integer', min: 5000, max: 120000, risk: 'single' },
  rateLimitWindowMs: { type: 'integer', min: 60000, max: 3600000, risk: 'single' },
  rateLimitMaxMessages: { type: 'integer', min: 1, max: 100, risk: 'single' },
  codexModel: { type: 'model', risk: 'double' },
};

const PUBLIC_CONFIG_KEYS = Object.keys(CONFIG_RULES);
const TARGET_RISK = {
  persona: 'single',
  bible: 'double',
  knowledgeCatalog: 'double',
};
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{20,}|(?:access|refresh)[_-]?token\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|app[_ -]?secret\s*[:=]\s*["']?[^\s"']{8,})/i;

function assertNoCredentials(value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  if (CREDENTIAL_PATTERN.test(serialized)) {
    throw new Error('Credential-like content cannot be stored by the configuration assistant');
  }
}

function normalizeConfigValue(key, value) {
  const rule = CONFIG_RULES[key];
  if (!rule) throw new Error(`${key} cannot be changed through the configuration assistant`);
  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    return value;
  }
  if (rule.type === 'integer') {
    if (!Number.isInteger(value) || value < rule.min || value > rule.max) {
      throw new Error(`${key} must be an integer between ${rule.min} and ${rule.max}`);
    }
    return value;
  }
  if (rule.type === 'string') {
    if (typeof value !== 'string' || value.length > rule.maxLength) {
      throw new Error(`${key} must be a string no longer than ${rule.maxLength} characters`);
    }
    assertNoCredentials(value);
    return value;
  }
  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) {
      throw new Error(`${key} must be one of: ${rule.values.join(', ')}`);
    }
    return value;
  }
  if (rule.type === 'chatIds') {
    if (!Array.isArray(value) || value.length > 100
      || value.some(item => typeof item !== 'string' || !/^oc_[A-Za-z0-9]+$/.test(item))) {
      throw new Error(`${key} must contain at most 100 valid oc_ chat IDs`);
    }
    return [...new Set(value)];
  }
  if (rule.type === 'model') {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)) {
      throw new Error(`${key} must be a valid model identifier`);
    }
    return value;
  }
  throw new Error(`Unsupported rule for ${key}`);
}

function normalizeDocumentContent(target, content) {
  if (typeof content !== 'string') throw new Error(`${target} content must be a string`);
  const maxLength = target === 'persona' ? 40000 : 60000;
  const normalized = content.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${target} content must contain 1 to ${maxLength} characters`);
  }
  assertNoCredentials(normalized);
  return `${normalized}\n`;
}

function normalizeCatalog(value) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error('knowledgeCatalog must be an array with at most 100 entries');
  }
  const normalized = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`knowledgeCatalog entry ${index + 1} must be an object`);
    }
    const token = String(item.token || '');
    const title = String(item.title || '').trim();
    const url = String(item.url || '').trim();
    const aliases = Array.isArray(item.aliases) ? item.aliases.map(value => String(value).trim()).filter(Boolean) : [];
    const readerOpenIds = Array.isArray(item.readerOpenIds) ? item.readerOpenIds.map(value => String(value)) : [];
    if (!/^[A-Za-z0-9_-]{8,}$/.test(token)) {
      throw new Error(`knowledgeCatalog entry ${index + 1} has an invalid document token`);
    }
    if (!title || title.length > 200) {
      throw new Error(`knowledgeCatalog entry ${index + 1} has an invalid title`);
    }
    if (url && !/^https:\/\/[^\s]+$/i.test(url)) {
      throw new Error(`knowledgeCatalog entry ${index + 1} has an invalid URL`);
    }
    if (readerOpenIds.some(id => !/^ou_[A-Za-z0-9]+$/.test(id))) {
      throw new Error(`knowledgeCatalog entry ${index + 1} has an invalid reader open ID`);
    }
    return {
      token,
      title,
      url,
      aliases: [...new Set(aliases)].slice(0, 30),
      readerOpenIds: [...new Set(readerOpenIds)].slice(0, 100),
    };
  });
  assertNoCredentials(normalized);
  return normalized;
}

function normalizeProposalChange(change, documents) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw new Error('Each proposed change must be an object');
  }
  const target = String(change.target || '');
  const reason = String(change.reason || '').trim().slice(0, 500);
  if (target === 'config') {
    const key = String(change.key || '');
    const after = normalizeConfigValue(key, change.value);
    const before = documents.config?.[key];
    return {
      target,
      key,
      label: key,
      before,
      after,
      reason,
      risk: CONFIG_RULES[key].risk,
    };
  }
  if (target === 'persona' || target === 'bible') {
    const after = normalizeDocumentContent(target, change.content);
    return {
      target,
      label: target === 'persona' ? 'Persona' : 'Operating Bible',
      before: documents[target] || '',
      after,
      reason,
      risk: TARGET_RISK[target],
    };
  }
  if (target === 'knowledgeCatalog') {
    const after = normalizeCatalog(change.value);
    return {
      target,
      label: 'Knowledge catalog',
      before: documents.knowledgeCatalog || [],
      after,
      reason,
      risk: TARGET_RISK[target],
    };
  }
  throw new Error(`${target || 'Unknown target'} cannot be changed through the configuration assistant`);
}

export function createChangePlan(proposal, documents, {
  id = `plan-${Date.now()}`,
  now = new Date().toISOString(),
} = {}) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Planner output must be an object');
  }
  if (!documents?.config || typeof documents.config !== 'object') {
    throw new Error('Current configuration is unavailable');
  }
  const proposedChanges = Array.isArray(proposal.changes) ? proposal.changes : [];
  if (proposedChanges.length > 20) throw new Error('A plan cannot contain more than 20 changes');
  const changes = proposedChanges
    .map(change => normalizeProposalChange(change, documents))
    .filter(change => !isDeepStrictEqual(change.before, change.after));
  const confirmationLevel = changes.some(change => change.risk === 'double')
    ? 'double'
    : changes.length ? 'single' : 'none';
  return {
    id,
    createdAt: now,
    summary: String(proposal.summary || (changes.length ? 'Configuration update' : 'Configuration answer')).trim().slice(0, 300),
    answer: String(proposal.answer || '').trim().slice(0, 4000),
    confirmationLevel,
    changes,
  };
}

export function applyChangePlan(documents, plan) {
  const updated = {
    config: structuredClone(documents.config),
    persona: documents.persona,
    bible: documents.bible,
    knowledgeCatalog: structuredClone(documents.knowledgeCatalog || []),
  };
  for (const change of plan?.changes || []) {
    if (change.target === 'config') updated.config[change.key] = structuredClone(change.after);
    else if (change.target === 'persona') updated.persona = change.after;
    else if (change.target === 'bible') updated.bible = change.after;
    else if (change.target === 'knowledgeCatalog') updated.knowledgeCatalog = structuredClone(change.after);
    else throw new Error(`Unsupported plan target: ${change.target}`);
  }
  return updated;
}

export function assertPlanMatchesDocuments(documents, plan) {
  for (const change of plan?.changes || []) {
    let current;
    if (change.target === 'config') current = documents.config?.[change.key];
    else if (change.target === 'persona') current = documents.persona;
    else if (change.target === 'bible') current = documents.bible;
    else if (change.target === 'knowledgeCatalog') current = documents.knowledgeCatalog;
    else throw new Error(`Unsupported plan target: ${change.target}`);
    if (!isDeepStrictEqual(current, change.before)) {
      throw new Error(`Configuration plan is stale because ${change.label || change.target} changed`);
    }
  }
  return true;
}

export function parsePlannerOutput(output) {
  const text = String(output || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Codex did not return a JSON change plan');
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(`Codex returned invalid change-plan JSON: ${error.message}`);
  }
  return parsed;
}

export function publicConfiguration(rawConfig) {
  return Object.fromEntries(PUBLIC_CONFIG_KEYS
    .filter(key => rawConfig?.[key] !== undefined)
    .map(key => [key, structuredClone(rawConfig[key])]));
}

export function effectivePublicConfiguration(defaults, overrides) {
  return {
    ...publicConfiguration(defaults),
    ...publicConfiguration(overrides),
  };
}

export const assistantSchema = {
  editableConfigKeys: [...PUBLIC_CONFIG_KEYS],
  blockedConfigKeys: [
    'feishuAppId',
    'ownerOpenId',
    'keychainService',
    'actionItemDocumentToken',
    'dashboardPort',
    'artifactDir',
    'codexBin',
    'codexProxyUrl',
    'larkCli',
    'nodeBin',
    'pythonBin',
  ],
};

export function validateAssistantRequest(request) {
  if (typeof request !== 'string') throw new Error('Configuration request must be text');
  const normalized = request.trim();
  if (!normalized) throw new Error('Configuration request cannot be empty');
  if (normalized.length > 4000) throw new Error('Configuration request is too long');
  assertNoCredentials(normalized);
  return normalized;
}

export function buildPlannerPrompt({ request, documents }) {
  const normalizedRequest = validateAssistantRequest(request);
  const safeConfig = publicConfiguration(documents?.config || {});
  return `
You are the AIPRO Configuration Planner. Convert the operator's natural-language
request into a constrained configuration plan. You plan changes only. You never
execute commands, edit files, reveal credentials, or claim that a change has
already been applied.

Return JSON only, with this exact top-level structure:
{
  "summary": "short operator-facing summary",
  "answer": "helpful explanation in Simplified Chinese",
  "changes": [
    {
      "target": "config",
      "key": "an allowed key",
      "value": "the correctly typed new value",
      "reason": "why this change matches the request"
    },
    {
      "target": "persona",
      "content": "the complete replacement PERSONA.md",
      "reason": "why"
    },
    {
      "target": "bible",
      "content": "the complete replacement BIBLE.md",
      "reason": "why"
    },
    {
      "target": "knowledgeCatalog",
      "value": [],
      "reason": "why"
    }
  ]
}

Rules:
- If the operator asks a question but does not request a change, return changes: [].
- Use only these editable config keys:
  ${assistantSchema.editableConfigKeys.join(', ')}
- Never propose these blocked keys:
  ${assistantSchema.blockedConfigKeys.join(', ')}
- Never include an App Secret, OAuth token, password, verification code, private
  key, shell command, executable path, or arbitrary file path.
- Preserve all unrelated Persona and Bible content.
- A Persona or Bible change must return the complete replacement file.
- A knowledgeCatalog change must return the complete JSON array.
- Use milliseconds for interval and timeout values.
- Do not use Markdown fences around the JSON.

Current editable configuration:
${JSON.stringify(safeConfig, null, 2)}

Current Persona:
${String(documents?.persona || '').slice(0, 40000)}

Current Operating Bible:
${String(documents?.bible || '').slice(0, 60000)}

Current knowledge catalog:
${JSON.stringify(documents?.knowledgeCatalog || [], null, 2).slice(0, 60000)}

Operator request:
${normalizedRequest}
`.trim();
}
