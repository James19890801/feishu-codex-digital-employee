#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isDirectExecution } from '../src/direct-execution.mjs';
import {
  buildProductionRelease,
  createReleaseVersion,
  inspectGitSource,
} from './production-release.mjs';

export function parseProductionReleaseArgs(argv) {
  const options = { source: '', supportRoot: '', tag: 'production', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--source') options.source = String(argv[++index] || '');
    else if (argument === '--support-root') options.supportRoot = String(argv[++index] || '');
    else if (argument === '--tag') options.tag = String(argv[++index] || '');
    else throw new Error(`Unknown production release option: ${argument}`);
  }
  if (!options.source) throw new Error('--source is required');
  if (!options.supportRoot) throw new Error('--support-root is required');
  if (!options.tag) throw new Error('--tag cannot be empty');
  return options;
}

async function main() {
  const options = parseProductionReleaseArgs(process.argv.slice(2));
  if (options.dryRun) {
    const inspected = await inspectGitSource({ source: options.source });
    console.log(JSON.stringify({
      dryRun: true,
      sourceSha: inspected.sha,
      version: createReleaseVersion({
        sha: inspected.sha,
        tag: options.tag,
        nowMs: Date.now(),
      }),
      supportRoot: path.resolve(options.supportRoot),
    }, null, 2));
    return;
  }
  const release = await buildProductionRelease({
    source: options.source,
    supportRoot: options.supportRoot,
    tag: options.tag,
  });
  console.log(JSON.stringify({
    version: release.version,
    path: release.path,
    sha: release.sha,
  }, null, 2));
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  main().catch(error => {
    console.error(`[production-release] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
