import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const security = await import('./dashboard-api-security.mjs').catch(() => ({}));

assert.equal(
  typeof security.isAllowedDashboardAction,
  'function',
  'isAllowedDashboardAction must exist before mutating dashboard APIs are added',
);
assert.equal(typeof security.parseDashboardJson, 'function');

const allowedHosts = new Set(['127.0.0.1:17655', 'localhost:17655']);
const valid = {
  host: '127.0.0.1:17655',
  origin: 'http://127.0.0.1:17655',
  action: 'config-plan',
  expectedAction: 'config-plan',
  token: 'session-token',
  expectedToken: 'session-token',
  allowedHosts,
};

assert.equal(security.isAllowedDashboardAction(valid), true);
assert.equal(security.isAllowedDashboardAction({ ...valid, origin: 'http://evil.example' }), false);
assert.equal(security.isAllowedDashboardAction({ ...valid, action: 'restart' }), false);
assert.equal(security.isAllowedDashboardAction({ ...valid, token: 'wrong' }), false);
assert.equal(security.isAllowedDashboardAction({ ...valid, host: 'evil.example' }), false);

assert.deepEqual(security.parseDashboardJson('{"message":"hello"}'), { message: 'hello' });
assert.throws(() => security.parseDashboardJson('[]'), /object/i);
assert.throws(() => security.parseDashboardJson('{broken'), /invalid json/i);
assert.throws(() => security.parseDashboardJson('{"x":"' + 'a'.repeat(70000) + '"}'), /too large/i);

const dashboardServer = await readFile(new URL('./dashboard-server.mjs', import.meta.url), 'utf8');
for (const route of [
  '/api/licensing/status',
  '/api/licensing/activate',
  '/api/licensing/invites',
]) {
  assert.equal(dashboardServer.includes(route), true, `${route} must be registered`);
}
assert.equal(dashboardServer.includes("allowedConfigAction(request, 'licensing-activate')"), true);
assert.equal(dashboardServer.includes("allowedConfigAction(request, 'licensing-generate')"), true);

console.log('DASHBOARD_API_SECURITY_TEST_OK');
