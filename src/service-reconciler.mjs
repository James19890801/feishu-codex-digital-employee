function clean(value) {
  return String(value || '').trim();
}

export function parseLaunchctlPrint(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const result = {
    raw,
    path: '',
    state: '',
    program: '',
    workdir: '',
    pid: 0,
    arguments: [],
  };
  let inArguments = false;
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (line === 'arguments = {') {
      inArguments = true;
      continue;
    }
    if (inArguments) {
      if (line === '}') {
        inArguments = false;
      } else if (line) {
        result.arguments.push(line);
      }
      continue;
    }
    const field = line.match(/^(path|state|program|working directory|pid) = (.*)$/);
    if (!field) continue;
    if (field[1] === 'working directory') result.workdir = clean(field[2]);
    else if (field[1] === 'pid') result.pid = Math.max(0, Number(field[2]) || 0);
    else result[field[1]] = clean(field[2]);
  }
  return result;
}

export function assessLaunchAgent(loaded, expected = {}) {
  if (!loaded) return { state: 'missing', differences: ['service_missing'] };
  const differences = [];
  if (clean(loaded.path) !== clean(expected.plistPath)) differences.push('plist_path');
  if (clean(loaded.workdir) !== clean(expected.workdir)) differences.push('working_directory');
  if (!Array.isArray(loaded.arguments)
    || !loaded.arguments.map(clean).includes(clean(expected.entrypoint))) {
    differences.push('entrypoint');
  }
  return {
    state: differences.length ? 'drifted' : 'healthy',
    differences,
  };
}

export function assessServiceLock(lock = {}, expected = {}) {
  if (lock.present !== true) return { state: 'absent', pid: 0 };
  const pid = Math.max(0, Number(lock.pid) || 0);
  if (!pid || lock.processAlive !== true) return { state: 'stale', pid };
  const command = clean(lock.processCommand);
  if (command.includes(clean(expected.entrypoint))) {
    return { state: 'active_expected', pid };
  }
  return { state: 'foreign', pid };
}

function reconciliationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function reconcileLaunchAgent({
  expected,
  inspect,
  inspectLock = async () => ({ present: false }),
  archiveStaleLock = async () => {},
  bootout,
  bootstrap,
  kickstart,
  verify,
} = {}) {
  for (const [name, operation] of Object.entries({
    inspect,
    inspectLock,
    archiveStaleLock,
    bootout,
    bootstrap,
    kickstart,
    verify,
  })) {
    if (typeof operation !== 'function') {
      throw new TypeError(`Service reconciler requires ${name}`);
    }
  }
  const loaded = await inspect();
  const definition = assessLaunchAgent(loaded, expected);
  let lock = assessServiceLock(await inspectLock(), expected);
  if (lock.state === 'foreign'
    && definition.state === 'healthy'
    && Number(loaded?.pid) > 0
    && Number(loaded.pid) === lock.pid) {
    lock = { ...lock, state: 'active_expected' };
  }
  if (lock.state === 'foreign') {
    throw reconciliationError(
      `Service lock belongs to an unexpected live process (pid ${lock.pid})`,
      'SERVICE_LOCK_FOREIGN',
    );
  }
  if (definition.state !== 'healthy' && lock.state === 'active_expected') {
    throw reconciliationError(
      `Expected service process is alive but not managed by the expected LaunchAgent (pid ${lock.pid})`,
      'SERVICE_PROCESS_UNMANAGED',
    );
  }
  if (lock.state === 'stale') await archiveStaleLock(lock);

  let action;
  if (definition.state === 'healthy') {
    await kickstart();
    action = 'kickstart';
  } else {
    if (loaded) await bootout();
    await bootstrap();
    action = 'rebootstrap';
  }
  await verify({ action, previousState: definition.state });
  return {
    action,
    previousState: definition.state,
    differences: definition.differences,
    archivedStaleLock: lock.state === 'stale',
  };
}

function abortableSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Service verification aborted'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Service verification aborted'));
    }, { once: true });
  });
}

export async function waitForServiceCondition({
  probe,
  timeoutMs = 30_000,
  intervalMs = 500,
  now = Date.now,
  sleep = abortableSleep,
  signal,
} = {}) {
  if (typeof probe !== 'function') throw new TypeError('Service condition probe is required');
  const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 30_000);
  const boundedIntervalMs = Math.max(1, Number(intervalMs) || 500);
  const startedAt = Number(now());
  while (true) {
    if (signal?.aborted) throw signal.reason || new Error('Service verification aborted');
    if (await probe({ signal })) return true;
    if (Number(now()) - startedAt >= boundedTimeoutMs) {
      throw reconciliationError('Service did not reach the required condition before timeout', 'SERVICE_VERIFY_TIMEOUT');
    }
    await sleep(boundedIntervalMs, signal);
  }
}
