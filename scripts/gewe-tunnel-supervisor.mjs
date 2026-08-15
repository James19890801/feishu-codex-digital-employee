#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class QuickTunnelUrlDetector {
  constructor({ maxBufferLength = 8_192 } = {}) {
    this.buffer = '';
    this.maxBufferLength = maxBufferLength;
  }

  push(chunk) {
    this.buffer = `${this.buffer}${String(chunk || '')}`.slice(-this.maxBufferLength);
    return this.buffer.match(QUICK_TUNNEL_PATTERN)?.[0] || null;
  }
}

function validateQuickTunnelUrl(publicUrl) {
  const parsed = new URL(String(publicUrl || ''));
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || !parsed.hostname.toLowerCase().endsWith('.trycloudflare.com')
    || parsed.pathname !== '/'
  ) {
    throw new Error('Cloudflare quick tunnel returned an invalid public URL');
  }
  return parsed.origin;
}

export async function updateCallbackConfiguration({
  configPath,
  publicUrl,
  restart,
}) {
  const normalizedUrl = validateQuickTunnelUrl(publicUrl);
  const currentText = await fs.readFile(configPath, 'utf8');
  const configuration = JSON.parse(currentText);
  if (configuration.gewePublicCallbackBaseUrl === normalizedUrl) return false;

  configuration.gewePublicCallbackBaseUrl = normalizedUrl;
  const temporaryPath = `${configPath}.gewe-tunnel-${process.pid}.tmp`;
  const mode = (await fs.stat(configPath)).mode;
  await fs.writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    mode,
    flag: 'wx',
  });
  try {
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  await restart();
  return true;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited with code ${code}: ${output.slice(-1_000)}`));
    });
  });
}

export async function superviseQuickTunnel({
  cloudflaredPath,
  configPath,
  callbackPort,
  serviceLabel,
}) {
  const detector = new QuickTunnelUrlDetector();
  const tunnel = spawn(cloudflaredPath, [
    'tunnel',
    '--no-autoupdate',
    '--url',
    `http://127.0.0.1:${callbackPort}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let configuredUrl = '';
  let configurationPromise = null;
  const inspectOutput = chunk => {
    process.stdout.write(chunk);
    const publicUrl = detector.push(chunk);
    if (!publicUrl || publicUrl === configuredUrl || configurationPromise) return;
    configuredUrl = publicUrl;
    configurationPromise = updateCallbackConfiguration({
      configPath,
      publicUrl,
      restart: () => runCommand('/bin/launchctl', [
        'kickstart',
        '-k',
        `gui/${process.getuid()}/${serviceLabel}`,
      ]),
    }).then(changed => {
      console.log(`[gewe-tunnel] callback base URL ${changed ? 'updated' : 'unchanged'}; personal WeChat service is aligned`);
    }).catch(error => {
      console.error('[gewe-tunnel] failed to align callback configuration:', error);
      tunnel.kill('SIGTERM');
      process.exitCode = 1;
    }).finally(() => {
      configurationPromise = null;
    });
  };

  tunnel.stdout.on('data', inspectOutput);
  tunnel.stderr.on('data', inspectOutput);
  tunnel.once('error', error => {
    console.error('[gewe-tunnel] cloudflared failed to start:', error);
    process.exitCode = 1;
  });

  const forwardSignal = signal => {
    if (!tunnel.killed) tunnel.kill(signal);
  };
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  process.once('SIGINT', () => forwardSignal('SIGINT'));

  const exitCode = await new Promise(resolve => tunnel.once('exit', code => resolve(code ?? 1)));
  if (configurationPromise) await configurationPromise;
  if (exitCode !== 0 && process.exitCode !== 1) process.exitCode = exitCode;
}

async function main() {
  const workspace = process.env.AIPRO_WORKSPACE || process.cwd();
  await superviseQuickTunnel({
    cloudflaredPath: process.env.CLOUDFLARED_PATH || path.join(process.env.HOME || '', '.local/bin/cloudflared'),
    configPath: process.env.AIPRO_CONFIG_PATH || path.join(workspace, 'config.local.json'),
    callbackPort: Number(process.env.GEWE_CALLBACK_PORT || 17_656),
    serviceLabel: process.env.AIPRO_SERVICE_LABEL || 'com.local.feishu-codex-digital-employee',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('[gewe-tunnel] supervisor failed:', error);
    process.exitCode = 1;
  });
}
