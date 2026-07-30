import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';
import { evaluateEventStatus } from '../src/reliability.mjs';

const { stdout } = await runBufferedProcess(config.larkCli, [
  'event', 'status', '--json', '--fail-on-orphan',
], {
  cwd: config.workdir,
  env: {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    PATH: `${config.nodeBin}:${join(process.env.HOME || '', '.local/bin')}:${process.env.PATH || ''}`,
  },
  timeoutMs: 15_000,
  maxStdoutBytes: 1024 * 1024,
  maxStderrBytes: 256 * 1024,
});
const status = JSON.parse(stdout);
const result = evaluateEventStatus(status, config.feishuAppId);
result.app = status.apps?.find(item => item?.app_id === config.feishuAppId) || null;
console.log(JSON.stringify(result, null, 2));
if (!result.healthy) process.exitCode = 1;
