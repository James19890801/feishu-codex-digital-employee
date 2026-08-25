import assert from 'node:assert/strict';
import { executeCloudHandoff } from './handoff.mjs';

class MemoryHandoffs {
  constructor() { this.records = new Map(); }
  async beginHandoff(id, digest) {
    const current = this.records.get(id);
    if (current) return { accepted: false, record: structuredClone(current) };
    const record = { state: 'in_progress', digest };
    this.records.set(id, record);
    return { accepted: true, record: structuredClone(record) };
  }
  async completeHandoff(id, result) {
    const record = { ...this.records.get(id), state: 'completed', result };
    this.records.set(id, record);
  }
  async failHandoff(id) { this.records.delete(id); }
}

const handoffId = 'a'.repeat(64);
const digest = 'b'.repeat(64);
const repository = new MemoryHandoffs();
let executions = 0;
const first = await executeCloudHandoff({
  repository, handoffId, digest,
  execute: async () => {
    executions += 1;
    return { text: 'cloud answer', sessionId: 'sess-1', latencyMs: 10 };
  },
});
assert.equal(first.handoff.replayed, false);
const replay = await executeCloudHandoff({
  repository, handoffId, digest,
  execute: async () => { executions += 1; throw new Error('must not execute'); },
});
assert.equal(executions, 1);
assert.equal(replay.result.text, 'cloud answer');
assert.equal(replay.handoff.replayed, true);

await assert.rejects(
  () => executeCloudHandoff({ repository, handoffId, digest: 'c'.repeat(64), execute: async () => ({}) }),
  error => error?.code === 'handoff_mismatch',
);

const inProgressRepository = new MemoryHandoffs();
await inProgressRepository.beginHandoff(handoffId, digest);
await assert.rejects(
  () => executeCloudHandoff({ repository: inProgressRepository, handoffId, digest, execute: async () => ({}) }),
  error => error?.code === 'handoff_in_progress',
);

const retryRepository = new MemoryHandoffs();
await assert.rejects(
  () => executeCloudHandoff({
    repository: retryRepository, handoffId, digest,
    execute: async () => { throw new Error('qoder unavailable'); },
  }),
  /qoder unavailable/,
);
const retried = await executeCloudHandoff({
  repository: retryRepository, handoffId, digest,
  execute: async () => ({ text: 'retried', sessionId: 'sess-2', latencyMs: 20 }),
});
assert.equal(retried.result.text, 'retried');

console.log('CLOUD_HANDOFF_TEST_OK');
