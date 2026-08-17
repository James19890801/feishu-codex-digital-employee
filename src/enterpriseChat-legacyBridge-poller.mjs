import {
  buildEnterpriseChatListAllPollingArgs,
  normalizeEnterpriseChatListAllPage,
} from './im-channels.mjs';

export function shouldRunEnterpriseChatSemanticObserver({
  enterpriseChatEnabled,
  semanticGroupEngagementEnabled,
  enterpriseChatTransport,
} = {}) {
  return Boolean(enterpriseChatEnabled
    && semanticGroupEngagementEnabled
    && !['event-stream', 'legacyBridge-polling'].includes(String(enterpriseChatTransport || '')));
}

export function semanticObserverFailureRecord(error, {
  failures = 1,
  delayMs = 0,
  at = new Date().toISOString(),
} = {}) {
  return {
    at,
    failures: Number(failures || 0),
    delayMs: Number(delayMs || 0),
    error: String(error?.message || error || '').slice(0, 1000),
  };
}

export async function fetchEnterpriseChatLegacyBridgeWindow({
  bin,
  start,
  end,
  ownerOpenId = '',
  ownerNames = [],
  mentionNames = [],
  includeUnmentionedGroups = false,
  run,
  runOptions = {},
  maxPages = 100,
} = {}) {
  if (typeof run !== 'function') throw new Error('EnterpriseChat LegacyBridge runner is required');
  const payloads = [];
  let cursor = '0';
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const { stdout, stderr } = await run(
      bin,
      buildEnterpriseChatListAllPollingArgs(start, end, cursor),
      runOptions,
    );
    let result;
    try {
      result = JSON.parse(stdout || '{}');
    } catch {
      throw new Error(`connector LegacyBridge poll returned invalid JSON: ${String(stderr || stdout || '').slice(-800)}`);
    }
    if (result?.success === false || result?.error) {
      throw new Error(`connector LegacyBridge poll failed: ${JSON.stringify(result.error || result).slice(0, 1000)}`);
    }
    const page = normalizeEnterpriseChatListAllPage(result, {
      ownerOpenId,
      ownerNames,
      mentionNames,
      includeUnmentionedGroups,
    });
    payloads.push(...page.payloads);
    if (!page.hasMore) return payloads;
    if (!page.nextCursor || page.nextCursor === '0' || page.nextCursor === cursor) {
      throw new Error('connector LegacyBridge poll pagination did not advance');
    }
    cursor = page.nextCursor;
  }
  throw new Error(`connector LegacyBridge poll exceeded ${maxPages} pages`);
}
