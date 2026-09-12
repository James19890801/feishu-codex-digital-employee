#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

function metricsAddress(value) {
  const match = String(value || '').match(/^(127\.0\.0\.1|localhost):([0-9]{1,5})$/);
  const port = Number(match?.[2]);
  if (!match || port < 1_024 || port > 65_535) throw new Error('Metrics address must use a loopback host and valid port');
  return `${match[1]}:${port}`;
}

export function namedTunnelArguments({ metricsAddress: value }) {
  return [
    'tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4',
    '--metrics', metricsAddress(value), 'run',
  ];
}

function credentialName(value, label) {
  const candidate = String(value || '');
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(candidate)) throw new Error(`Tunnel Keychain ${label} is invalid`);
  return candidate;
}

export async function readTunnelToken({ service, account, chunks = 1 }) {
  const safeService = credentialName(service, 'service');
  const safeAccount = credentialName(account, 'account');
  const count = Number(chunks);
  if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error('Tunnel token chunk count is invalid');
  const values = [];
  for (let index = 1; index <= count; index += 1) {
    const chunkAccount = count === 1 ? safeAccount : `${safeAccount}:${index}`;
    const result = await execFileAsync('/usr/bin/security', [
      'find-generic-password', '-w', '-s', safeService, '-a', chunkAccount,
    ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 });
    values.push(String(result.stdout || '').trim());
  }
  const token = values.join('');
  if (token.length < 16 || token.length > 8_192) throw new Error('Tunnel token is invalid');
  return token;
}

export async function superviseNamedTunnel({
  cloudflaredPath,
  metricsAddress: address,
  keychainService,
  keychainAccount,
  keychainChunks = 1,
}) {
  const token = await readTunnelToken({
    service: keychainService,
    account: keychainAccount,
    chunks: keychainChunks,
  });
  const environment = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SSL_CERT_FILE']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  environment.TUNNEL_TOKEN = token;
  const child = spawn(cloudflaredPath, namedTunnelArguments({ metricsAddress: address }), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  });
  const safeLog = chunk => process.stdout.write(String(chunk).split(token).join('[REDACTED]'));
  child.stdout.on('data', safeLog);
  child.stderr.on('data', safeLog);
  let stopping = false;
  const stop = signal => {
    stopping = true;
    if (!child.killed) child.kill(signal);
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve(Number.isInteger(exitCode) ? exitCode : stopping && signal ? 0 : 1));
  });
  if (code !== 0) process.exitCode = code;
  return code;
}

async function main() {
  return superviseNamedTunnel({
    cloudflaredPath: process.env.CLOUDFLARED_PATH || path.join(process.env.HOME || '', '.local', 'bin', 'cloudflared'),
    metricsAddress: process.env.CLOUDFLARED_METRICS_ADDRESS || '127.0.0.1:17657',
    keychainService: process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_SERVICE,
    keychainAccount: process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_ACCOUNT,
    keychainChunks: Number(process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_CHUNKS || 1),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[named-tunnel] ${error?.message || 'failed'}`);
    process.exitCode = 1;
  });
}
