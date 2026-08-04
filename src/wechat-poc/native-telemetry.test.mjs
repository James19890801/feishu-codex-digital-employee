import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatNativeTelemetry, parseWeChatNativeTelemetry } from './native-telemetry.mjs';

const selection = '1785560400688,2,search_result_item,view_clk,1785560419677,AI流程与组织变革交流一群,{"item_index":0;"item_name":"AI流程与组织变革交流一群";"item_sub_index":0;"item_type":3;"module_type":2;"tab_scene":1}';
const article = '1785560400688,2,search_result_item,view_clk,1785560419777,AI流程与组织变革交流一群,{"item_index":1;"item_name":"AI流程与组织变革交流一群";"item_sub_index":0;"item_type":4;"module_type":0;"tab_scene":1}';
const send = 'send_msg,m5363,1785560454427,,{"chatname":"54103319902@chatroom";"line_count":2;"paragraph_count":0;"word_count":56}';
const parsed = parseWeChatNativeTelemetry(`${selection}\u0018${article}\u0018${send}`);
assert.equal(parsed.length, 3);
assert.deepEqual(parsed[0], {
  kind: 'selection',
  cursor: 1785560419677,
  itemName: 'AI流程与组织变革交流一群',
  itemType: 3,
  moduleType: 2,
  clickedAt: 1785560419677,
});
assert.equal(parsed[1].itemType, 4);
assert.equal(parsed[2].chatName, '54103319902@chatroom');
assert.equal(parsed[2].wordCount, 56);

const directory = await mkdtemp(join(tmpdir(), 'james-wechat-telemetry-'));
try {
  await writeFile(join(directory, 'key_fixture_input.statistic'), `${selection}\u0018${send}`);
  const telemetry = new WeChatNativeTelemetry({ directory, timeoutMs: 50, pollMs: 5 });
  const events = await telemetry.events();
  assert.equal(events.length, 2);
  assert.equal(await telemetry.waitForSelection({
    title: 'AI流程与组织变革交流一群',
    afterCursor: 1785560419000,
  }).then(event => event.itemType), 3);
  assert.equal(await telemetry.waitForSendReceipt({
    afterCursor: 1785560454000,
  }).then(event => event.chatName), '54103319902@chatroom');
  assert.equal(await telemetry.waitForSelection({
    title: '不存在的群',
    afterCursor: 1785560419000,
  }), null);
  console.log('WECHAT_POC_NATIVE_TELEMETRY_TEST_OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}
