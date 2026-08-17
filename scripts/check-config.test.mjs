import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const result = spawnSync(process.execPath, ['scripts/check-config.mjs'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    DIGITAL_EMPLOYEE_CONFIG: '',
  },
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /CONFIG_TEMPLATE_OK/u);

console.log('CHECK_CONFIG_TEST_OK');
