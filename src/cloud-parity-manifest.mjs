import { createHash } from 'node:crypto';

// This is an export contract, not a list of every option in config.local.json.
// New production settings require review before they may leave the Mac.
export const CLOUD_PARITY_CONFIG_KEYS = Object.freeze([
  'allowAllChats', 'authorizedChatIds', 'digitalTwinLabel',
  'dingtalkEnabled', 'dingtalkOwnerOpenId', 'geweEnabled', 'geweMentionNames',
  'geweMomentsEngagementEnabled', 'geweMomentsInteractionBlocklist',
  'geweMomentsMaxProactivePerDay', 'geweMomentsMaxRepliesPerDay',
  'geweMomentsMaxThreadDepth', 'geweMomentsPostMaxAgeHours',
  'geweMomentsPublisherEnabled', 'geweNewcomerWelcomeEnabled',
  'geweOwnerArticlePublisherIds', 'geweOwnerArticleSyndicationEnabled',
  'geweOwnerArticleWechatIds', 'groupHostChatIds', 'groupHostModeEnabled',
  'groupHostReplyCooldownMs', 'groupHostSilenceMs', 'maxConcurrentReplies',
  'ownerOpenId', 'rateLimitMaxMessages', 'rateLimitWindowMs',
  'semanticGroupAliases', 'semanticGroupEngagementEnabled',
  'semanticGroupEntryCooldownMs', 'semanticGroupReplyThreshold',
  'wechatP2pRedPacketGateEnabled', 'wechatP2pRedPacketGateThreshold',
]);

export const CLOUD_PARITY_STATE_COLUMNS = Object.freeze({
  relationship_person: ['person_id', 'channel', 'external_id', 'display_name', 'remark', 'aliases',
    'first_seen_at', 'last_seen_at', 'updated_at', 'has_sent_red_packet',
    'red_packet_first_seen_at', 'red_packet_source_message_id'],
  relationship_profile: ['person_id', 'display_name', 'familiarity', 'tone', 'topics',
    'open_loops', 'summary', 'confidence', 'updated_at'],
  relationship_fact: ['fact_id', 'person_id', 'kind', 'content', 'fingerprint', 'confidence',
    'audience_scope', 'source_event_id', 'valid_from', 'valid_until', 'status', 'created_at', 'updated_at'],
  relationship_episode: ['event_id', 'person_id', 'channel', 'surface', 'context_id',
    'audience_scope', 'direction', 'content', 'source_ref', 'occurred_at', 'importance',
    'processed_at', 'created_at'],
  owner_consultation: ['id', 'channel', 'owner_id', 'owner_chat_id', 'origin_chat_id',
    'origin_chat_type', 'requester_id', 'requester_label', 'source_message_id', 'request_text',
    'decision_prompt', 'suggested_reply', 'owner_notification_message_id',
    'owner_response_message_id', 'decision', 'approved_reply', 'status', 'reminder_at_ms',
    'expires_at_ms', 'reminded_at_ms', 'resolved_at_ms', 'created_at_ms', 'updated_at_ms',
    'purpose', 'location_label', 'cost_category', 'request_fingerprint', 'task_snapshot',
    'execution_started_at_ms', 'execution_completed_at_ms'],
});

const SECRET_PATTERN = /\bBearer\s+\S+|-----BEGIN [^-]*PRIVATE KEY-----|\b(?:sk|pt)-[A-Za-z0-9_-]{10,}\b/i;
const MAX_SECTION_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 24 * 1024 * 1024;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(text) { return createHash('sha256').update(text).digest('hex'); }

function simpleConfigValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  return Array.isArray(value) && value.every(item => item === null
    || ['string', 'number', 'boolean'].includes(typeof item));
}

function section(data) {
  const serialized = stableJson(data);
  if (SECRET_PATTERN.test(serialized)) throw new Error('secret-like content in parity state');
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_SECTION_BYTES) throw new Error('parity section too large');
  return { data, digest: hash(serialized), bytes };
}

export function buildParityManifest({ config = {}, persona = '', bible = '', instructions = '', state = {} } = {}) {
  for (const [name, document] of Object.entries({ persona, bible, instructions })) {
    if (typeof document !== 'string') throw new Error(`${name} must be text`);
  }
  const selectedConfig = Object.fromEntries(CLOUD_PARITY_CONFIG_KEYS
    .filter(key => Object.hasOwn(config, key) && simpleConfigValue(config[key]))
    .map(key => [key, config[key]]));
  const selectedState = {};
  for (const [table, columns] of Object.entries(CLOUD_PARITY_STATE_COLUMNS)) {
    if (!Object.hasOwn(state, table)) continue;
    if (!Array.isArray(state[table]) || state[table].length > 50_000) {
      throw new Error(`invalid parity state table: ${table}`);
    }
    selectedState[table] = state[table].map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`invalid parity state row: ${table}`);
      }
      return Object.fromEntries(columns.filter(column => Object.hasOwn(row, column))
        .map(column => [column, row[column]]));
    });
  }
  const sections = {
    persona: section(persona), bible: section(bible), instructions: section(instructions),
    config: section(selectedConfig), state: section(selectedState),
  };
  const totalBytes = Object.values(sections).reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > MAX_MANIFEST_BYTES) throw new Error('parity manifest too large');
  const digest = hash(stableJson(Object.fromEntries(Object.entries(sections)
    .map(([name, item]) => [name, item.digest]))));
  return { version: 1, digest, totalBytes, sections };
}
