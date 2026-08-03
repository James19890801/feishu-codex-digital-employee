import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ui = await import('./licensing-ui.js').catch(() => ({}));
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

assert.equal(typeof ui.normalizeInvitationCode, 'function');
assert.equal(ui.normalizeInvitationCode(' 123 456 7890 '), '1234567890');
assert.equal(ui.normalizeInvitationCode('1234a567890'), '');
assert.equal(ui.canShowInviteStudio({
  activated: true,
  edition: 'Founder',
  issuer: { authorized: true },
}), true);
assert.equal(ui.canShowInviteStudio({
  activated: true,
  edition: 'Business',
  issuer: { authorized: false },
}), false);
assert.deepEqual(ui.licensingRequestHeaders('licensing-generate', 'token'), {
  'content-type': 'application/json',
  'x-dashboard-action': 'licensing-generate',
  'x-dashboard-session': 'token',
});
assert.match(ui.invitationCsv(['1234567890', '9876543210']), /1234567890/);

for (const id of [
  'activationGate',
  'activationForm',
  'activationCode',
  'activationSubmit',
  'operationsConsole',
  'inviteStudio',
  'generateInvitesButton',
  'invitationCodes',
  'copyInvitesButton',
  'downloadInvitesButton',
]) {
  assert.match(html, new RegExp(`id="${id}"`));
}
assert.match(html, /maxlength="10"/);
assert.doesNotMatch(html, /value="\d{10}"/);

console.log('LICENSING_UI_TEST_OK');
