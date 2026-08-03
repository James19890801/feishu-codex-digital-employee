import assert from 'node:assert/strict';
import { multicaIssueUrl } from './multica-links.mjs';

assert.equal(
  multicaIssueUrl({ workspace_slug: 'my-super-work-space', identifier: 'MYS-5' }),
  'https://multica.ai/my-super-work-space/issues/MYS-5',
);
assert.equal(
  multicaIssueUrl(
    { workspace_slug: '研发 空间', identifier: '研发-5' },
    'https://multica.example.com/',
  ),
  'https://multica.example.com/%E7%A0%94%E5%8F%91%20%E7%A9%BA%E9%97%B4/issues/%E7%A0%94%E5%8F%91-5',
);
assert.equal(multicaIssueUrl({ identifier: 'MYS-5' }), '');
assert.equal(multicaIssueUrl({ workspace_slug: 'my-space' }), '');
assert.throws(
  () => multicaIssueUrl(
    { workspace_slug: 'my-space', identifier: 'MYS-5' },
    'javascript:alert(1)',
  ),
  /http/i,
);

console.log('MULTICA_LINKS_TEST_OK');
