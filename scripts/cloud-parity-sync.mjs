#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectParityManifest } from '../src/cloud-parity-collector.mjs';
import { CloudParitySync } from '../src/cloud-parity-sync.mjs';

function argumentsFrom(argv) {
  const options = { dryRun: false,
    root: join(homedir(), 'Library', 'Application Support', 'AIPRO') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--dry-run') options.dryRun = true;
    else if (argv[index] === '--root' && argv[index + 1]) options.root = argv[++index];
    else throw new Error('usage: cloud-parity-sync.mjs [--dry-run] [--root PATH]');
  }
  return options;
}

function keychainToken() {
  try {
    return execFileSync('/usr/bin/security', ['find-generic-password',
      '-s', 'ai.aipro.cloud-parity', '-a', 'token', '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { throw new Error('cloud parity token unavailable in Keychain'); }
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  const source = () => collectParityManifest({ root: options.root });
  const manifest = await source();
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ digest: manifest.digest,
      totalBytes: manifest.totalBytes,
      sectionBytes: Object.fromEntries(Object.entries(manifest.sections)
        .map(([name, value]) => [name, value.bytes])) })}\n`);
  } else {
    const sync = new CloudParitySync({
      baseUrl: process.env.AIPRO_PARITY_BASE_URL || 'https://wxrelay.e2eskill.cn',
      token: keychainToken(), workerId: 'mac', manifestSource: async () => manifest,
    });
    const result = await sync.reconcile();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${String(error?.message || 'cloud parity sync failed').slice(0, 160)}\n`);
  process.exitCode = 1;
}
