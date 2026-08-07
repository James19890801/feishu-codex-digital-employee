import assert from 'node:assert/strict';
import { DomainError, FailoverCoordinatorService, InMemoryFailoverRepository } from './domain.mjs';

const repository = new InMemoryFailoverRepository();
const service = new FailoverCoordinatorService({ repository });
await service.heartbeat({ at: 0, serviceStartId: 'start-1', dwsConnected: true, runtimeHealthy: true });
assert.equal((await service.evaluate(89_999)).state, 'LOCAL_PRIMARY');
assert.equal((await service.evaluate(90_000)).state, 'TAKING_OVER');
assert.equal((await service.evaluate(90_000)).generation, 1, 'alarm replay must be idempotent');
await assert.rejects(() => service.containerReady(0), error => error instanceof DomainError
  && error.code === 'stale_generation');
assert.equal((await service.containerReady(1)).state, 'CLOUD_ACTIVE');
const digest = 'a'.repeat(64);
assert.equal((await service.claim({ generation: 1, messageDigest: digest })).accepted, true);
assert.equal((await service.claim({ generation: 1, messageDigest: digest })).accepted, false);
await assert.rejects(() => service.claim({ generation: 0, messageDigest: 'b'.repeat(64) }),
  error => error.code === 'stale_generation');
await service.heartbeat({ at: 100_000, serviceStartId: 'start-2', dwsConnected: true, runtimeHealthy: true });
await service.heartbeat({ at: 130_000, serviceStartId: 'start-2', dwsConnected: true, runtimeHealthy: true });
assert.equal((await service.heartbeat({ at: 160_000, serviceStartId: 'start-2', dwsConnected: true, runtimeHealthy: true })).state,
  'DRAINING');
await assert.rejects(() => service.claim({ generation: 1, messageDigest: 'c'.repeat(64) }),
  error => error.code === 'claims_closed');
assert.equal((await service.complete({ generation: 1, messageDigest: digest, at: 170_000 })).state,
  'LOCAL_PRIMARY');
console.log('FAILOVER_DOMAIN_TEST_OK');
