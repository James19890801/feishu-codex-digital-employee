import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspaceArtifact } from './workspace-artifact.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipro-workspace-artifact-'));
const workspace = join(root, 'workspace');
const nested = join(workspace, 'outputs');
await mkdir(nested, { recursive: true });

const artifact = join(nested, 'report.pdf');
await writeFile(artifact, 'pdf');
assert.equal(await resolveWorkspaceArtifact(artifact, workspace), artifact);

const outside = join(root, 'outside.pdf');
await writeFile(outside, 'secret');
await assert.rejects(
  resolveWorkspaceArtifact(outside, workspace),
  /outside the AIPRO workspace/i,
);

const escapingLink = join(nested, 'escape.pdf');
await symlink(outside, escapingLink);
await assert.rejects(
  resolveWorkspaceArtifact(escapingLink, workspace),
  /symbolic link|outside the AIPRO workspace/i,
);

await assert.rejects(
  resolveWorkspaceArtifact(nested, workspace),
  /regular file/i,
);

console.log('WORKSPACE_ARTIFACT_TEST_OK');
