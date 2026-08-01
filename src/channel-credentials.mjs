import { runBufferedProcess } from './process-runner.mjs';

function validatedTarget(target) {
  const service = String(target?.service || '').trim();
  const account = String(target?.account || '').trim();
  if (!service || !account || service.length > 200 || account.length > 200
    || /[\u0000-\u001f\u007f]/.test(`${service}${account}`)) {
    throw new Error('Keychain credential target is invalid');
  }
  return { service, account };
}

async function readCredential(target, run) {
  const { service, account } = validatedTarget(target);
  const { stdout } = await run('/usr/bin/security', [
    'find-generic-password', '-a', account, '-s', service, '-w',
  ], {
    timeoutMs: 10_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
  });
  return String(stdout || '').replace(/[\r\n]+$/, '');
}

async function writeCredential(target, credential, run) {
  const { service, account } = validatedTarget(target);
  await run('/usr/bin/security', [
    'add-generic-password', '-U', '-a', account, '-s', service, '-w',
  ], {
    input: `${credential}\n${credential}\n`,
    timeoutMs: 10_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
  });
}

async function deleteCredential(target, run) {
  const { service, account } = validatedTarget(target);
  await run('/usr/bin/security', [
    'delete-generic-password', '-a', account, '-s', service,
  ], {
    timeoutMs: 10_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
  });
}

export async function keychainCredentialExists(target, { run = runBufferedProcess } = {}) {
  try {
    return Boolean(await readCredential(target, run));
  } catch {
    return false;
  }
}

export async function replaceKeychainCredential(target, credential, {
  run = runBufferedProcess,
} = {}) {
  const value = String(credential || '');
  if (value.length < 8 || value.length > 4096 || /[\r\n\u0000]/.test(value)) {
    throw new Error('Keychain credential is invalid');
  }
  let previous = null;
  try {
    previous = await readCredential(target, run);
  } catch {
    previous = null;
  }
  try {
    await writeCredential(target, value, run);
  } catch {
    throw new Error('Keychain credential could not be stored');
  }
  return async () => {
    try {
      if (previous !== null) await writeCredential(target, previous, run);
      else await deleteCredential(target, run);
    } catch {
      throw new Error('Keychain credential rollback failed');
    }
  };
}
