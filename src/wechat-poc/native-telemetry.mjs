import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

const SELECTION = /(\d+),2,search_result_item,view_clk,(\d+),([^,\x00]*),\{"item_index":(\d+);"item_name":"([^"]*)";"item_sub_index":\d+;"item_type":(\d+);"module_type":(\d+);"tab_scene":\d+\}/g;
const SEND = /send_msg,[^,\x00]*,(\d+),,\{"chatname":"([^"]+)";"line_count":(\d+);"paragraph_count":(\d+);"word_count":(\d+)\}/g;

function numeric(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : 0;
}

function parseEvents(text) {
  const events = [];
  for (const match of text.matchAll(SELECTION)) {
    events.push({
      kind: 'selection',
      cursor: numeric(match[2]),
      itemName: match[5],
      itemType: numeric(match[6]),
      moduleType: numeric(match[7]),
      clickedAt: numeric(match[2]),
    });
  }
  for (const match of text.matchAll(SEND)) {
    events.push({
      kind: 'send',
      cursor: numeric(match[1]),
      chatName: match[2],
      lineCount: numeric(match[3]),
      paragraphCount: numeric(match[4]),
      wordCount: numeric(match[5]),
    });
  }
  return events.sort((left, right) => left.cursor - right.cursor);
}

export class WeChatNativeTelemetry {
  constructor({
    directory = join(homedir(), 'Library', 'Containers', 'com.tencent.xinWeChat',
      'Data', 'Documents', 'app_data', 'net', 'kvcomm'),
    timeoutMs = 3_000,
    pollMs = 80,
  } = {}) {
    this.directory = directory;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.lastCursor = 0;
  }

  async events() {
    let names = [];
    try { names = await readdir(this.directory); } catch { return []; }
    const candidates = names.filter(name => name.endsWith('_input.statistic'));
    const chunks = await Promise.all(candidates.map(async name => {
      try { return await readFile(join(this.directory, name), 'utf8'); } catch { return ''; }
    }));
    const events = chunks.flatMap(parseEvents).sort((left, right) => left.cursor - right.cursor);
    if (events.length) this.lastCursor = Math.max(this.lastCursor, events.at(-1).cursor);
    return events;
  }

  cursor() {
    return this.lastCursor || Date.now() - 1;
  }

  async refreshCursor() {
    await this.events();
    return this.cursor();
  }

  async waitFor(predicate, { afterCursor = 0 } = {}) {
    const deadline = Date.now() + this.timeoutMs;
    do {
      const event = (await this.events()).findLast(item => item.cursor > afterCursor && predicate(item));
      if (event) return event;
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    } while (Date.now() <= deadline);
    return null;
  }

  waitForSelection({ title, afterCursor = 0 }) {
    const expected = String(title || '').trim();
    return this.waitFor(event => event.kind === 'selection' && event.itemName === expected, { afterCursor });
  }

  waitForSendReceipt({ afterCursor = 0 }) {
    return this.waitFor(event => event.kind === 'send', { afterCursor });
  }
}

export { parseEvents as parseWeChatNativeTelemetry };
