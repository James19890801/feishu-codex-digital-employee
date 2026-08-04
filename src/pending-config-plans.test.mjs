import assert from 'node:assert/strict';

const module = await import('./pending-config-plans.mjs').catch(() => ({}));

assert.equal(
  typeof module.PendingConfigurationPlans,
  'function',
  'PendingConfigurationPlans must exist before plans can be confirmed',
);

let now = 1_000_000;
const plans = new module.PendingConfigurationPlans({
  now: () => now,
  ttlMs: 60_000,
  maxPlans: 3,
});

const single = plans.add({
  id: 'plan-single',
  confirmationLevel: 'single',
  changes: [{ target: 'config' }],
});
assert.equal(single.id, 'plan-single');
assert.equal(single.confirmationCode, '');
assert.equal(plans.get('plan-single').id, 'plan-single');
assert.equal(plans.consume('plan-single').id, 'plan-single');
assert.throws(() => plans.consume('plan-single'), /not found/i);

plans.add({
  id: 'plan-double',
  confirmationLevel: 'double',
  changes: [{ target: 'bible' }],
}, { confirmationCode: '482731' });
assert.throws(
  () => plans.consume('plan-double', { confirmationCode: '000000' }),
  /confirmation code/i,
);
assert.equal(
  plans.consume('plan-double', { confirmationCode: '482731' }).id,
  'plan-double',
);

plans.add({
  id: 'plan-expiring',
  confirmationLevel: 'single',
  changes: [{ target: 'config' }],
});
now += 60_001;
assert.throws(() => plans.get('plan-expiring'), /expired/i);

plans.add({ id: 'plan-1', confirmationLevel: 'single', changes: [] });
plans.add({ id: 'plan-2', confirmationLevel: 'single', changes: [] });
plans.add({ id: 'plan-3', confirmationLevel: 'single', changes: [] });
plans.add({ id: 'plan-4', confirmationLevel: 'single', changes: [] });
assert.equal(plans.size, 3);
assert.throws(() => plans.get('plan-1'), /not found/i);

console.log('PENDING_CONFIG_PLANS_TEST_OK');
