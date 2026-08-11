import { config } from '../src/config.mjs';
import { A1Client } from '../src/a1-client.mjs';

if (!config.a1Enabled) {
  console.log(JSON.stringify({ enabled: false, skipped: true }));
  process.exit(0);
}

const client = new A1Client({
  bin: config.a1Bin,
  defaultProjectId: config.a1DefaultProjectId,
  timeoutMs: config.helperTimeoutMs,
  maxWorkitems: config.a1MaxWorkitems,
});
const identity = await client.whoami();
const workitems = await client.listWorkitems({
  scope: 'personal',
  category: 'req,bug,task',
  pageSize: Math.min(10, config.a1MaxWorkitems),
});
console.log(JSON.stringify({
  enabled: true,
  authenticated: true,
  identity: String(
    identity.realName || identity.displayName || identity.name || identity.nickName || identity.empId || 'authenticated',
  ),
  workitems: workitems.length,
  ids: workitems.map(item => item.id),
}));
