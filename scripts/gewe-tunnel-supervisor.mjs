#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../src/direct-execution.mjs';

const QUICK_TUNNEL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function assertQuickTunnelFallbackAllowed({ runtimeMode, allowFallback }) {
  if (String(runtimeMode || '').toLowerCase() === 'production' && allowFallback !== true) {
    throw new Error('Cloudflare Quick Tunnel is disabled in production unless emergency fallback is explicit');
  }
  return true;
}

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

export function quickTunnelArguments({ callbackPort, metricsAddress }) {
  const port = Number(callbackPort);
  const metrics = String(metricsAddress || '');
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error('Cloudflare quick tunnel callback port is invalid');
  }
  if (!/^(127\.0\.0\.1|localhost):([0-9]{4,5})$/.test(metrics)) {
    throw new Error('Cloudflare quick tunnel metrics address must use loopback');
  }
  const metricsPort = Number(metrics.split(':').at(-1));
  if (metricsPort < 1_024 || metricsPort > 65_535) {
    throw new Error('Cloudflare quick tunnel metrics port is invalid');
  }
  return [
    'tunnel', '--no-autoupdate', '--edge-ip-version', '4',
    '--metrics', metrics,
    '--url', `http://127.0.0.1:${port}`,
  ];
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
  metricsAddress = '127.0.0.1:17657',
  serviceLabel,
  reliabilityServiceLabel = '',
  runtimeMode = 'development',
  allowFallback = false,
}) {
  assertQuickTunnelFallbackAllowed({ runtimeMode, allowFallback });
  const detector = new QuickTunnelUrlDetector();
  const tunnel = spawn(cloudflaredPath, quickTunnelArguments({
    callbackPort,
    metricsAddress,
  }), { stdio: ['ignore', 'pipe', 'pipe'] });

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
      restart: async () => {
        const labels = [serviceLabel, reliabilityServiceLabel].filter(Boolean);
        for (const label of labels) {
          await runCommand('/bin/launchctl', [
            'kickstart', '-k', `gui/${process.getuid()}/${label}`,
          ]);
        }
      },
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
    metricsAddress: process.env.CLOUDFLARED_METRICS_ADDRESS || '127.0.0.1:17657',
    serviceLabel: process.env.AIPRO_SERVICE_LABEL || 'com.local.feishu-codex-digital-employee',
    reliabilityServiceLabel: process.env.AIPRO_RELIABILITY_SERVICE_LABEL || '',
    runtimeMode: process.env.AIPRO_RUNTIME_MODE || 'production',
    allowFallback: process.env.AIPRO_ALLOW_QUICK_TUNNEL_FALLBACK === 'true',
  });
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch(error => {
    console.error('[gewe-tunnel] supervisor failed:', error);
    process.exitCode = 1;
  });
}
