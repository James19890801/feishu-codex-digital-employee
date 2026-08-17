import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectDingTalkReadiness,
  parseDwsJson,
} from './dingtalk-readiness.mjs';

assert.deepEqual(parseDwsJson('prefix\n{"success":true}\nsuffix'), { success: true });
assert.equal(parseDwsJson('not json'), null);

const sandbox = await mkdtemp(join(tmpdir(), 'james-dingtalk-readiness-'));
const dws = join(sandbox, 'dws');
await writeFile(dws, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "dws v1.0.58"; exit 0; fi
if [ "$1" = "--profile" ]; then shift 2; fi
if [ "$1" = "auth" ]; then
  echo '{"success":true,"authenticated":true,"corp_id":"corp-1","user_id":"user-1"}'
  exit 0
fi
if [ "$1" = "profile" ]; then
  echo '{"success":true,"currentProfile":"corp-1:user-1","profiles":[{"profile":"corp-1:user-1"}]}'
  exit 0
fi
exit 2
`, 'utf8');
await chmod(dws, 0o755);

const ready = inspectDingTalkReadiness({
  dwsBin: dws,
  profile: '',
  channelCode: '',
  env: { HOME: sandbox },
});
assert.equal(ready.installed, true);
assert.equal(ready.version, 'dws v1.0.58');
assert.equal(ready.authenticated, true);
assert.equal(ready.profileConfigured, true);
assert.equal(ready.profile, 'corp-1:user-1');
assert.equal(ready.channelCodeConfigured, false);
assert.equal(ready.connectorReady, true, 'a channel code is optional outside controlled organizations');
assert.equal(ready.eventStreamReady, false, 'auth readiness must not be confused with a live stream');

const missing = inspectDingTalkReadiness({
  dwsBin: join(sandbox, 'missing-dws'),
  profile: '',
  channelCode: 'approved-channel',
  env: { HOME: sandbox },
});
assert.equal(missing.installed, false);
assert.equal(missing.authenticated, false);
assert.equal(missing.connectorReady, false);
assert.equal(missing.channelCodeConfigured, true);

console.log('DINGTALK_READINESS_TEST_OK');
