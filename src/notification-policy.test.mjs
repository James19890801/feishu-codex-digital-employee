import assert from 'node:assert/strict';
import { notificationEvent } from './notification-policy.mjs';

assert.equal(notificationEvent('', 'online'), null);
assert.equal(notificationEvent('', 'degraded'), 'incident');
assert.equal(notificationEvent('', 'offline'), 'incident');
assert.equal(notificationEvent('online', 'degraded'), 'incident');
assert.equal(notificationEvent('degraded', 'offline'), 'incident');
assert.equal(notificationEvent('offline', 'degraded'), 'partial_recovery');
assert.equal(notificationEvent('degraded', 'online'), 'recovered');
assert.equal(notificationEvent('offline', 'online'), 'recovered');
assert.equal(notificationEvent('degraded', 'degraded'), null);
assert.equal(notificationEvent('online', 'online'), null);

console.log('NOTIFICATION_POLICY_TEST_OK');
