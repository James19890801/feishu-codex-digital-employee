import assert from 'node:assert/strict';
import {
  assessLaunchAgent,
  assessServiceLock,
  parseLaunchctlPrint,
  reconcileLaunchAgent,
} from './service-reconciler.mjs';

const expected = {
  plistPath: '/Users/operator/Library/LaunchAgents/com.local.aipro.plist',
  workdir: '/Applications/AIPRO',
  entrypoint: '/Applications/AIPRO/src/index.mjs',
};

function launchctlOutput({
  path = expected.plistPath,
  workdir = expected.workdir,
  entrypoint = expected.entrypoint,
  state = 'running',
  pid = 4321,
} = {}) {
  return `gui/501/com.local.aipro = {
\tpath = ${path}
\tstate = ${state}
\tprogram = /usr/local/bin/node
\targuments = {
\t\t/usr/local/bin/node
\t\t${entrypoint}
\t}
\tworking directory = ${workdir}
\tpid = ${pid}
}`;
}

const parsed = parseLaunchctlPrint(launchctlOutput());
assert.equal(parsed.path, expected.plistPath);
assert.equal(parsed.workdir, expected.workdir);
assert.equal(parsed.pid, 4321);
assert.equal(parsed.arguments.includes(expected.entrypoint), true);
assert.equal(assessLaunchAgent(parsed, expected).state, 'healthy');

const drifted = parseLaunchctlPrint(launchctlOutput({
  path: '/private/tmp/audit/agent.plist',
  workdir: '/private/tmp/audit/source',
  entrypoint: '/private/tmp/audit/source/src/index.mjs',
}));
assert.equal(assessLaunchAgent(drifted, expected).state, 'drifted');
assert.deepEqual(assessLaunchAgent(null, expected), {
  state: 'missing',
  differences: ['service_missing'],
});

assert.equal(assessServiceLock({ present: false }, expected).state, 'absent');
assert.equal(assessServiceLock({ present: true, pid: 99, processAlive: false }, expected).state, 'stale');
assert.equal(assessServiceLock({
  present: true,
  pid: 99,
  processAlive: true,
  processCommand: `/usr/local/bin/node ${expected.entrypoint}`,
}, expected).state, 'active_expected');
assert.equal(assessServiceLock({
  present: true,
  pid: 99,
  processAlive: true,
  processCommand: '/usr/local/bin/node /private/tmp/other/index.mjs',
}, expected).state, 'foreign');

async function runCase({ loaded, lock, verifyError = null } = {}) {
  const calls = [];
  const result = await reconcileLaunchAgent({
    expected,
    inspect: async () => loaded,
    inspectLock: async () => lock || { present: false },
    archiveStaleLock: async () => { calls.push('archive-lock'); },
    bootout: async () => { calls.push('bootout'); },
    bootstrap: async () => { calls.push('bootstrap'); },
    kickstart: async () => { calls.push('kickstart'); },
    verify: async () => {
      calls.push('verify');
      if (verifyError) throw verifyError;
    },
  });
  return { calls, result };
}

{
  const { calls, result } = await runCase({ loaded: parsed });
  assert.deepEqual(calls, ['kickstart', 'verify']);
  assert.equal(result.action, 'kickstart');
}

{
  const { calls, result } = await runCase({
    loaded: drifted,
    lock: { present: true, pid: 44, processAlive: false },
  });
  assert.deepEqual(calls, ['archive-lock', 'bootout', 'bootstrap', 'verify']);
  assert.equal(result.action, 'rebootstrap');
  assert.equal(result.previousState, 'drifted');
}

{
  const { calls, result } = await runCase({ loaded: null });
  assert.deepEqual(calls, ['bootstrap', 'verify']);
  assert.equal(result.action, 'rebootstrap');
  assert.equal(result.previousState, 'missing');
}

await assert.rejects(
  runCase({
    loaded: null,
    lock: {
      present: true,
      pid: 55,
      processAlive: true,
      processCommand: `/usr/local/bin/node ${expected.entrypoint}`,
    },
  }),
  error => error?.code === 'SERVICE_PROCESS_UNMANAGED',
);

{
  const calls = [];
  await assert.rejects(
    reconcileLaunchAgent({
      expected,
      inspect: async () => drifted,
      inspectLock: async () => ({ present: false }),
      archiveStaleLock: async () => { calls.push('archive-lock'); },
      bootout: async () => { calls.push('bootout'); },
      bootstrap: async () => { calls.push('bootstrap'); },
      kickstart: async () => { calls.push('kickstart'); },
      verify: async () => { calls.push('verify'); throw new Error('not ready'); },
    }),
    /not ready/,
  );
  assert.deepEqual(calls, ['bootout', 'bootstrap', 'verify']);
}

console.log('SERVICE_RECONCILER_TEST_OK');
