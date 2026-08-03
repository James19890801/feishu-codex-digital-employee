export const DEFAULT_MULTICA_APP_URL = 'https://multica.ai';

export function multicaIssueUrl(issue, appUrl = DEFAULT_MULTICA_APP_URL) {
  const workspaceSlug = String(issue?.workspace_slug || '').trim();
  const identifier = String(issue?.identifier || '').trim();
  if (!workspaceSlug || !identifier) return '';
  const base = new URL(String(appUrl || DEFAULT_MULTICA_APP_URL));
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Multica app URL must use http or https without credentials');
  }
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(workspaceSlug)}`
    + `/issues/${encodeURIComponent(identifier)}`;
  base.search = '';
  base.hash = '';
  return base.href.replace(/\/$/, '');
}
