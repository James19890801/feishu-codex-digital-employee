import { config } from '../src/config.mjs';
import { MulticaClient } from '../src/multica-client.mjs';

if (!config.multicaEnabled) {
  console.log(JSON.stringify({ enabled: false, skipped: true }));
  process.exit(0);
}

const client = new MulticaClient({
  bin: config.multicaBin,
  profile: config.multicaProfile,
  defaultWorkspaceId: config.multicaDefaultWorkspaceId,
  timeoutMs: config.helperTimeoutMs,
  maxIssues: config.multicaMaxIssues,
});
const workspaces = await client.listWorkspaces();
const issues = await client.listAllIssues({ workspaces });
console.log(JSON.stringify({
  enabled: true,
  profile: config.multicaProfile,
  workspaces: workspaces.length,
  issues: issues.length,
}));
