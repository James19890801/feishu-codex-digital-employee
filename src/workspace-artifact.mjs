import { lstat, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export async function resolveWorkspaceArtifact(filePath, workspaceRoot) {
  const requested = resolve(String(filePath || ''));
  const workspace = await realpath(resolve(String(workspaceRoot || '')));
  const requestedInfo = await lstat(requested);
  if (requestedInfo.isSymbolicLink()) {
    throw new Error('Workspace artifact must not be a symbolic link');
  }
  if (!requestedInfo.isFile()) {
    throw new Error('Workspace artifact must be a regular file');
  }
  const resolved = await realpath(requested);
  const pathFromWorkspace = relative(workspace, resolved);
  if (pathFromWorkspace === '..' || pathFromWorkspace.startsWith(`..${sep}`)
    || resolve(workspace, pathFromWorkspace) !== resolved) {
    throw new Error('Artifact is outside the AIPRO workspace');
  }
  return requested;
}
