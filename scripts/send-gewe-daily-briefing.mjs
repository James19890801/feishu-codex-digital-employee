import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.mjs';
import { readKeychainCredential } from '../src/channel-credentials.mjs';
import { deliverGeWeDailyBriefing } from '../src/gewe-daily-briefing.mjs';
import { GeWeChannel } from '../src/im-channel-runtime.mjs';
import { AgentState } from '../src/state.mjs';

async function readStandardInput() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function briefingDateFromArgs(argv) {
  const index = argv.indexOf('--date');
  const value = index >= 0 ? String(argv[index + 1] || '').trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('--date YYYY-MM-DD is required');
  }
  return value;
}

export async function runGeWeDailyBriefingCli({
  argv = process.argv.slice(2),
  readStdin = readStandardInput,
  configuration = config,
  readCredential = readKeychainCredential,
  createState = path => new AgentState(path),
  createChannel = options => new GeWeChannel(options),
  deliver = deliverGeWeDailyBriefing,
  writeOutput = value => process.stdout.write(`${value}\n`),
} = {}) {
  const briefingDate = briefingDateFromArgs(argv);
  if (!configuration.geweEnabled || !configuration.geweAppId) {
    throw new Error('Personal WeChat GeWe channel is not configured');
  }
  if (!configuration.geweDailyBriefingGroupId || !configuration.geweDailyBriefingGroupName) {
    throw new Error('Personal WeChat daily briefing target is not configured');
  }
  const content = await readStdin();
  const token = await readCredential({
    service: configuration.geweKeychainService,
    account: configuration.geweAppId,
  });
  if (!token) throw new Error('Personal WeChat GeWe token is empty');
  const state = createState(join(configuration.workdir, 'data', 'agent-state.sqlite'));
  try {
    const channel = createChannel({
      appId: configuration.geweAppId,
      token,
      apiBaseUrl: configuration.geweApiBaseUrl,
    });
    const delivery = await deliver({
      state,
      channel,
      briefingDate,
      groupId: configuration.geweDailyBriefingGroupId,
      groupName: configuration.geweDailyBriefingGroupName,
      content,
    });
    const output = {
      ok: true,
      briefingDate,
      groupName: configuration.geweDailyBriefingGroupName,
      replayed: delivery.replayed === true,
    };
    writeOutput(JSON.stringify(output));
    return output;
  } finally {
    state.close();
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runGeWeDailyBriefingCli().catch(error => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: String(error?.message || error).slice(0, 500),
    })}\n`);
    process.exitCode = 1;
  });
}
