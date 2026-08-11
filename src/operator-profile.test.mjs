import assert from 'node:assert/strict';
import { normalizeOperatorProfile } from './operator-profile.mjs';

assert.deepEqual(normalizeOperatorProfile({}), {
  displayName: '账号本人',
  role: '',
  aliases: [],
  brandName: 'Personal Digital Human',
  ownerLabel: '账号本人',
});

assert.deepEqual(normalizeOperatorProfile({
  displayName: ' 新用户 ',
  role: ' 产品经理 ',
  aliases: ['小新', '小新', '', '  New User  '],
  brandName: ' 新用户的数字人 ',
}), {
  displayName: '新用户',
  role: '产品经理',
  aliases: ['小新', 'New User'],
  brandName: '新用户的数字人',
  ownerLabel: '新用户',
});

const bounded = normalizeOperatorProfile({
  displayName: 'x'.repeat(300),
  role: 'y'.repeat(500),
  aliases: Array.from({ length: 50 }, (_, index) => `alias-${index}`),
  brandName: 'z'.repeat(300),
});
assert.equal(bounded.displayName.length, 80);
assert.equal(bounded.role.length, 160);
assert.equal(bounded.aliases.length, 20);
assert.equal(bounded.brandName.length, 120);

console.log('OPERATOR_PROFILE_TEST_OK');
