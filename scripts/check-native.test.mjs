import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./check-native.mjs', import.meta.url));

for (const platform of ['win32', 'linux']) {
  for (const mode of ['app', 'multimodal']) {
    const result = spawnSync(process.execPath, [
      script, '--platform', platform, '--mode', mode,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${platform}/${mode}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`NATIVE_CHECK_OK platform=${platform} mode=${mode}`));
  }
}

console.log('CHECK_NATIVE_TEST_OK');
