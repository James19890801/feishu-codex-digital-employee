import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const packagedInstaller = join(packageRoot, 'payload', 'scripts', 'install-aicoding.mjs');
const sourceInstaller = join(packageRoot, 'scripts', 'install-aicoding.mjs');
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  throw new Error('Node.js 22.13+ is required');
}
const sqliteProbe = spawnSync(process.execPath, [
  '--input-type=module',
  '--eval',
  "await import('node:sqlite')",
], { encoding: 'utf8' });
if (sqliteProbe.status !== 0) {
  throw new Error('This Node.js runtime cannot load node:sqlite; install Node.js 22.13+');
}

let installerRoot = packageRoot;
let installer = packagedInstaller;
let temporaryPackageRoot = '';
if (!existsSync(packagedInstaller)) {
  const distributionBuilder = join(packageRoot, 'scripts', 'distribution-package.mjs');
  if (existsSync(distributionBuilder)) {
    temporaryPackageRoot = await mkdtemp(join(tmpdir(), 'personal-digital-human-source-'));
    const { buildDistribution } = await import('./scripts/distribution-package.mjs');
    const packageMetadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    const built = await buildDistribution({
      root: packageRoot,
      outputDir: temporaryPackageRoot,
      version: packageMetadata.version,
      createArchive: false,
    });
    installerRoot = built.directory;
    installer = join(installerRoot, 'payload', 'scripts', 'install-aicoding.mjs');
  } else {
    installer = sourceInstaller;
  }
}
if (!existsSync(installer)) {
  throw new Error('Installation layout is incomplete: install-aicoding.mjs was not found');
}

const result = spawnSync(process.execPath, [installer, installerRoot, ...process.argv.slice(2)], {
  cwd: installerRoot,
  env: process.env,
  stdio: 'inherit',
});
if (temporaryPackageRoot) {
  await rm(temporaryPackageRoot, { recursive: true, force: true });
}

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
