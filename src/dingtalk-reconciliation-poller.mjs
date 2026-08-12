import {
  buildDingTalkListAllPollingArgs,
  normalizeDingTalkListAllPage,
} from './im-channels.mjs';

export async function fetchDingTalkReconciliationWindow({
  bin,
  profile = '',
  start,
  end,
  ownerOpenId = '',
  ownerNames = [],
  mentionNames = [],
  run,
  runOptions = {},
  maxPages = 100,
} = {}) {
  if (typeof run !== 'function') throw new Error('DingTalk reconciliation runner is required');
  const payloads = [];
  let cursor = '0';
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const args = [
      ...(profile ? ['--profile', profile] : []),
      ...buildDingTalkListAllPollingArgs(start, end, cursor),
    ];
    const { stdout, stderr } = await run(bin, args, runOptions);
    let result;
    try {
      result = JSON.parse(stdout || '{}');
    } catch {
      throw new Error(`dws reconciliation returned invalid JSON: ${String(stderr || stdout || '').slice(-800)}`);
    }
    if (result?.success === false || result?.error) {
      throw new Error(`dws reconciliation failed: ${JSON.stringify(result.error || result).slice(0, 1000)}`);
    }
    const page = normalizeDingTalkListAllPage(result, {
      ownerOpenId,
      ownerNames,
      mentionNames,
      source: 'event-stream-reconciliation',
    });
    payloads.push(...page.payloads);
    if (!page.hasMore) return payloads;
    if (!page.nextCursor || page.nextCursor === '0' || page.nextCursor === cursor) {
      throw new Error('dws reconciliation pagination did not advance');
    }
    cursor = page.nextCursor;
  }
  throw new Error(`dws reconciliation exceeded ${maxPages} pages`);
}
