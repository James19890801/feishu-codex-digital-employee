import assert from 'node:assert/strict';
import {
  DwsMailClient,
  DwsMailError,
  normalizeDeliveryStatus,
} from './dws-mail-client.mjs';

const calls = [];
const audits = [];
const responses = [];
const runner = async (command, args, options) => {
  calls.push({ command, args, options });
  const response = responses.shift();
  if (response instanceof Error) throw response;
  return { stdout: JSON.stringify(response), stderr: '', exitCode: 0 };
};

const client = new DwsMailClient({
  bin: '/opt/homebrew/bin/dws',
  profile: 'corp:user',
  transport: 'event-stream',
  env: { DWS_CHANNEL: 'channel-secret' },
  cwd: '/srv/aipro',
  runner,
  audit: (event, detail) => audits.push({ event, detail }),
});

responses.push({
  success: true,
  result: {
    emailAccounts: [{ email: 'owner@example.com', type: 'ORG', orgName: 'Example' }],
  },
});
const mailboxes = await client.listMailboxes();
assert.deepEqual(mailboxes, [{ email: 'owner@example.com', type: 'ORG', orgName: 'Example' }]);
assert.deepEqual(calls.at(-1).args, [
  '--profile', 'corp:user', 'mail', 'mailbox', 'list', '--format', 'json',
]);

responses.push({
  success: true,
  result: {
    messages: [{
      id: 'message-1', subject: '周报',
      from: { email: 'sender@example.com', name: '同事甲' },
      receivedDateTime: '2026-08-05T01:00:00Z', isRead: false,
      hasAttachments: true, conversationId: 'thread-1',
    }],
    nextCursor: '$', total: 1,
  },
});
const search = await client.searchMessages({
  email: 'owner@example.com', query: 'folderId:2 AND isRead:false', limit: 10,
});
assert.deepEqual(calls.at(-1).args, [
  '--profile', 'corp:user', 'mail', 'message', 'search',
  '--email', 'owner@example.com', '--query', 'folderId:2 AND isRead:false',
  '--limit', '10', '--format', 'json',
]);
assert.equal(search.messages[0].id, 'message-1');
assert.equal(search.messages[0].from.name, '同事甲');
assert.equal(search.nextCursor, '$');

responses.push({
  success: true,
  result: {
    message: {
      id: 'message-1', subject: '周报', markdownBody: '# 本周\n完成 A',
      from: { email: 'sender@example.com', name: '同事甲' },
      toRecipients: [{ email: 'owner@example.com', name: 'Owner' }],
      ccRecipients: [], receivedDateTime: '2026-08-05T01:00:00Z',
      conversationId: 'thread-1',
    },
  },
});
const message = await client.getMessage({ email: 'owner@example.com', id: 'message-1' });
assert.equal(message.markdownBody, '# 本周\n完成 A');
assert.deepEqual(calls.at(-1).args, [
  '--profile', 'corp:user', 'mail', 'message', 'get',
  '--email', 'owner@example.com', '--id', 'message-1', '--format', 'json',
]);

responses.push({ success: true, result: { internetMessageId: '<sent-1@example.com>' } });
const sent = await client.sendMessage({
  from: 'owner@example.com', to: ['target@example.com'], cc: ['cc@example.com'],
  subject: '周报', content: '完成 A',
});
assert.equal(sent.internetMessageId, '<sent-1@example.com>');
assert.deepEqual(calls.at(-1).args, [
  '--profile', 'corp:user', 'mail', 'message', 'send',
  '--from', 'owner@example.com', '--to', 'target@example.com',
  '--cc', 'cc@example.com', '--subject', '周报', '--content', '完成 A',
  '--yes', '--format', 'json',
]);

responses.push({ success: true, result: { message: { sendStatus: 'success' } } });
assert.equal(await client.verifyDelivery({
  email: 'owner@example.com', internetMessageId: '<sent-1@example.com>',
}), 'success');
assert.deepEqual(calls.at(-1).args, [
  '--profile', 'corp:user', 'mail', 'message', 'verify',
  '--email', 'owner@example.com', '--internet-message-id', '<sent-1@example.com>',
  '--format', 'json',
]);

assert.equal(normalizeDeliveryStatus({ message: { sendStatus: 'partial_success' } }), 'partial_success');
assert.equal(normalizeDeliveryStatus({ result: { sendStatus: 'failed' } }), 'failed');
assert.equal(normalizeDeliveryStatus({ sendStatus: 'posting' }), 'posting');
assert.equal(normalizeDeliveryStatus({ sendStatus: 'unexpected' }), 'unknown');

assert.doesNotMatch(
  JSON.stringify(audits),
  /owner@example\.com|target@example\.com|sender@example\.com|周报|完成 A|message-1|sent-1/,
);
assert.equal(audits.every(item => item.event.startsWith('dws_mail_')), true);

await assert.rejects(
  new DwsMailClient({
    bin: '/tmp/.real/.bin/dws/bin/dws', profile: 'corp:user',
    transport: 'event-stream', runner,
  }).listMailboxes(),
  error => error instanceof DwsMailError && error.code === 'DWS_MAIL_PATH_REJECTED',
);
await assert.rejects(
  new DwsMailClient({
    bin: '/opt/homebrew/bin/dws', profile: 'corp:user',
    transport: 'wukong-polling', runner,
  }).listMailboxes(),
  error => error instanceof DwsMailError && error.code === 'DWS_MAIL_TRANSPORT_REJECTED',
);

const malformed = new DwsMailClient({
  bin: '/opt/homebrew/bin/dws', profile: 'corp:user', transport: 'event-stream',
  runner: async () => ({ stdout: '<html>bad</html>', stderr: '', exitCode: 0 }),
});
await assert.rejects(
  malformed.listMailboxes(),
  error => error instanceof DwsMailError && error.code === 'DWS_MAIL_INVALID_JSON',
);

responses.push({ success: false, error: { category: 'auth', message: 'not authenticated' } });
await assert.rejects(
  client.listMailboxes(),
  error => error instanceof DwsMailError
    && error.code === 'DWS_MAIL_PROVIDER_ERROR'
    && /not authenticated/.test(error.message),
);

console.log('DWS_MAIL_CLIENT_TEST_OK');
