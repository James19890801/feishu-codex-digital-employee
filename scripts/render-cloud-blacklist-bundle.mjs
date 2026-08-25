import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeCommunicationBlocklist } from '../src/communication-blocklist.mjs';
import { projectDingTalkCloudBlacklist } from '../src/cloud-blacklist-projection.mjs';

export async function renderCloudBlacklistBundle({ configPath, outputPath } = {}) {
  if (!configPath || !outputPath) throw new TypeError('configPath and outputPath are required');
  const raw = JSON.parse(await readFile(resolve(configPath), 'utf8'));
  const projected = projectDingTalkCloudBlacklist(
    normalizeCommunicationBlocklist(raw.automaticCommunicationBlocklist),
  );
  const bundle = {
    AIPROS_ACCESS_MODE: 'blacklist',
    AIPROS_BLOCKED_SENDER_IDS: projected.senderIds.join(','),
    AIPROS_BLOCKED_CHAT_IDS: projected.chatIds.join(','),
    sourceEntryCount: projected.sourceEntryCount,
    senderCount: projected.senderCount,
    digest: projected.digest,
  };
  await writeFile(resolve(outputPath), `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
  await chmod(resolve(outputPath), 0o600);
  return {
    ok: true,
    sourceEntryCount: projected.sourceEntryCount,
    senderCount: projected.senderCount,
    digest: projected.digest,
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const summary = await renderCloudBlacklistBundle({
    configPath: option('--config'),
    outputPath: option('--output'),
  });
  console.log(JSON.stringify(summary));
}
