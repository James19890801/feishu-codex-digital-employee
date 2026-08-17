import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function createInstallerFixture(relativeInstaller, marker) {
  const fixture = await mkdtemp(join(tmpdir(), 'source-install-entrypoint-'));
  await copyFile(join(root, 'install.mjs'), join(fixture, 'install.mjs'));
  const installerPath = join(fixture, relativeInstaller);
  await mkdir(dirname(installerPath), { recursive: true });
  await writeFile(installerPath, [
    "import assert from 'node:assert/strict';",
    "import { resolve } from 'node:path';",
    'assert.equal(resolve(process.argv[2]), resolve(process.cwd()));',
    "assert.equal(process.argv[3], '--help');",
    `console.log('${marker}');`,
    '',
  ].join('\n'), 'utf8');
  return fixture;
}

const sourceFixture = await createInstallerFixture(
  join('scripts', 'install-aicoding.mjs'),
  'SOURCE_INSTALLER_OK',
);
let result = spawnSync(process.execPath, ['install.mjs', '--help'], {
  cwd: sourceFixture,
  encoding: 'utf8',
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /SOURCE_INSTALLER_OK/u);

const packagedFixture = await createInstallerFixture(
  join('payload', 'scripts', 'install-aicoding.mjs'),
  'PACKAGED_INSTALLER_OK',
);
result = spawnSync(process.execPath, ['install.mjs', '--help'], {
  cwd: packagedFixture,
  encoding: 'utf8',
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /PACKAGED_INSTALLER_OK/u);

const installSandbox = await mkdtemp(join(tmpdir(), 'source-install-full-'));
const installRoot = join(installSandbox, 'installed');
result = spawnSync(process.execPath, [join(root, 'install.mjs')], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: installSandbox,
    ACHONG_INSTALL_HOME: installSandbox,
    ACHONG_INSTALL_ROOT: installRoot,
    ACHONG_SKIP_DEPENDENCIES: '1',
    ACHONG_SKIP_SERVICES: '1',
    ACHONG_SKIP_OPEN: '1',
    JAMES_INSTALL_PLATFORM: 'linux',
  },
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /INSTALL_OK/u);
await access(join(installRoot, 'config.local.json'));

console.log('SOURCE_INSTALL_ENTRYPOINT_TEST_OK');
