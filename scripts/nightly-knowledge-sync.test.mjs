import assert from 'node:assert/strict';
import { findNodeId } from './nightly-knowledge-sync.mjs';

const fuzzySearchResult = {
  success: true,
  documents: [
    { name: '知识日报 2026-08-04', nodeId: 'node-04' },
    { name: '知识日报 2026-08-07', nodeId: 'node-07' },
  ],
};

assert.equal(
  findNodeId(fuzzySearchResult, '知识日报 2026-08-08'),
  '',
  'a fuzzy Wiki search result must not reuse a differently named daily node',
);

assert.equal(
  findNodeId({ documents: [{ name: '知识日报 2026-08-08', nodeId: 'node-08' }] }, '知识日报 2026-08-08'),
  'node-08',
  'an exact daily node match must be reused',
);

assert.equal(
  findNodeId({ success: true, nodeId: 'node-created' }, '知识日报 2026-08-08'),
  'node-created',
  'a newly created node response must still be accepted',
);

console.log('nightly knowledge sync node matching tests passed');
