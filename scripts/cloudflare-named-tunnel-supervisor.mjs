#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

function validateMetricsAddress(value) {
  const match = String(value || '').match(/^(127\.0\.0\.1|localhost):([0-9]{1,5})$/);
  const port = Number(match?.[2]);
  if (!match || port < 1_024 || port > 65_535) {
    throw new Error('Cloudflare metrics address must be a loopback host and valid port');
  }
  return `${match[1]}:${port}`;
}

export function namedTunnelArguments({ metricsAddress }) {
  return [
    'tunnel', '--no-autoupdate',
    '--edge-ip-version', '4',
    '--metrics', validateMetricsAddress(metricsAddress),
    'run',
  ];
}

function validateKeychainName(value, name) {
  const candidate = String(value || '');
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(candidate)) {
    throw new Error(`Tunnel Keychain ${name} is invalid`);
  }
  return candidate;
}

export async function readTunnelToken({
  service,
  account,
  chunks = 1,
  run = async (command, args) => execFileAsync(command, args, {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  }),
}) {
  const safeService = validateKeychainName(service, 'service');
  const safeAccount = validateKeychainName(account, 'account');
  const chunkCount = Number(chunks);
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 8) {
    throw new Error('Tunnel Keychain chunk count is invalid');
  }
  const values = [];
  for (let index = 1; index <= chunkCount; index += 1) {
    const chunkAccount = chunkCount === 1 ? safeAccount : `${safeAccount}:${index}`;
    const result = await run('/usr/bin/security', [
      'find-generic-password', '-w', '-s', safeService, '-a', chunkAccount,
    ]);
    values.push(String(result?.stdout || '').trim());
  }
  const token = values.join('');
  if (token.length < 16 || token.length > 8_192) {
    throw new Error('Tunnel token from Keychain is empty or invalid');
  }
  return token;
}

function safeEnvironment(environment, token) {
  const safe = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE']) {
    if (environment?.[name]) safe[name] = environment[name];
  }
  safe.TUNNEL_TOKEN = token;
  return safe;
}

function redact(value, token) {
  const text = String(value || '');
  return token ? text.split(token).join('[REDACTED]') : text;
}

export async function superviseNamedTunnel({
  cloudflaredPath,
  metricsAddress,
  keychainService,
  keychainAccount,
  keychainChunks = 1,
  readToken = () => readTunnelToken({
    service: keychainService,
    account: keychainAccount,
    chunks: keychainChunks,
  }),
  spawnImpl = spawn,
  processLike = process,
  logger = console,
  shutdownTimeoutMs = 10_000,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}) {
  const token = await readToken();
  const args = namedTunnelArguments({ metricsAddress });
  const child = spawnImpl(cloudflaredPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: safeEnvironment(processLike.env, token),
  });
  let exited = false;
  let terminationRequested = false;
  let shutdownTimer = null;

  const logOutput = chunk => logger.info(redact(chunk, token));
  child.stdout?.on('data', logOutput);
  child.stderr?.on('data', logOutput);

  const forwardSignal = signal => {
    if (exited) return;
    terminationRequested = true;
    child.kill(signal);
    if (!shutdownTimer) {
      shutdownTimer = schedule(() => {
        if (!exited) child.kill('SIGKILL');
      }, Math.max(1_000, Number(shutdownTimeoutMs) || 10_000));
    }
  };
  const onSigterm = () => forwardSignal('SIGTERM');
  const onSigint = () => forwardSignal('SIGINT');
  processLike.once('SIGTERM', onSigterm);
  processLike.once('SIGINT', onSigint);

  const exitCode = await new Promise(resolve => {
    let resolved = false;
    const finish = code => {
      if (resolved) return;
      resolved = true;
      resolve(code);
    };
    child.once('error', error => {
      logger.error(redact(`[named-tunnel] cloudflared failed to start: ${error?.message || error}`, token));
      finish(1);
    });
    child.once('exit', (code, signal) => {
      if (Number.isInteger(code)) finish(code);
      else finish(terminationRequested && signal ? 0 : 1);
    });
  });

  exited = true;
  if (shutdownTimer) cancelSchedule(shutdownTimer);
  processLike.removeListener?.('SIGTERM', onSigterm);
  processLike.removeListener?.('SIGINT', onSigint);
  if (exitCode !== 0) {
    logger.error(`[named-tunnel] cloudflared exited with code ${exitCode}`);
    processLike.exitCode = exitCode;
  }
  return exitCode;
}

async function main() {
  await superviseNamedTunnel({
    cloudflaredPath: process.env.CLOUDFLARED_PATH
      || path.join(process.env.HOME || '', '.local', 'bin', 'cloudflared'),
    metricsAddress: process.env.CLOUDFLARED_METRICS_ADDRESS || '127.0.0.1:17657',
    keychainService: process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_SERVICE,
    keychainAccount: process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_ACCOUNT,
    keychainChunks: Number(process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_CHUNKS || 1),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[named-tunnel] supervisor failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
