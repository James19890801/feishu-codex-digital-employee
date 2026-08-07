import assert from 'node:assert/strict';
import { DurableObjectFailoverRepository } from './repository-do.mjs';

class FakeStorage {
  constructor() { this.map = new Map(); }
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) { this.map.set(key, structuredClone(value)); }
}
const repository = new DurableObjectFailoverRepository(new FakeStorage());
assert.equal((await repository.read()).state, 'LOCAL_PRIMARY');
const next = { ...(await repository.read()), state: 'TAKING_OVER', generation: 1 };
await repository.write(next);
assert.equal((await repository.read()).generation, 1);
assert.equal(await repository.claim(`1:${'a'.repeat(64)}`, { generation: 1, at: 1 }), true);
assert.equal(await repository.claim(`1:${'a'.repeat(64)}`, { generation: 1, at: 1 }), false);
assert.equal(await repository.complete(`1:${'a'.repeat(64)}`, { completedAt: 2, outcomeCode: 'sent' }), true);
assert.equal(await repository.complete(`1:${'a'.repeat(64)}`, { completedAt: 3, outcomeCode: 'sent' }), false);
assert.equal(await repository.use('node', 'nonce', 100, 1), true);
assert.equal(await repository.use('node', 'nonce', 100, 1), false);
console.log('FAILOVER_DO_REPOSITORY_TEST_OK');
