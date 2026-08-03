import {
  buildDingTalkListAllPollingArgs,
  normalizeDingTalkListAllPage,
} from './im-channels.mjs';

export async function fetchDingTalkWukongWindow({
  bin,
  start,
  end,
  ownerOpenId = '',
  ownerNames = [],
  mentionNames = [],
  run,
  runOptions = {},
  maxPages = 100,
} = {}) {
  if (typeof run !== 'function') throw new Error('DingTalk Wukong runner is required');
  const payloads = [];
  let cursor = '0';
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const { stdout, stderr } = await run(
      bin,
      buildDingTalkListAllPollingArgs(start, end, cursor),
      runOptions,
    );
    let result;
    try {
      result = JSON.parse(stdout || '{}');
    } catch {
      throw new Error(`dws Wukong poll returned invalid JSON: ${String(stderr || stdout || '').slice(-800)}`);
    }
    if (result?.success === false || result?.error) {
      throw new Error(`dws Wukong poll failed: ${JSON.stringify(result.error || result).slice(0, 1000)}`);
    }
    const page = normalizeDingTalkListAllPage(result, {
      ownerOpenId,
      ownerNames,
      mentionNames,
    });
    payloads.push(...page.payloads);
    if (!page.hasMore) return payloads;
    if (!page.nextCursor || page.nextCursor === '0' || page.nextCursor === cursor) {
      throw new Error('dws Wukong poll pagination did not advance');
    }
    cursor = page.nextCursor;
  }
  throw new Error(`dws Wukong poll exceeded ${maxPages} pages`);
}
