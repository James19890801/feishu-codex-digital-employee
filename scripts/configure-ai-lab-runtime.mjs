import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chmod } from 'node:fs/promises';
import {
  createConfigurationSnapshot,
  readConfigurationDocuments,
  writeConfigurationDocuments,
} from '../src/config-store.mjs';
import { normalizeAiLabRuntimeConfiguration } from '../src/ai-runtime.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function applyAiLabRuntimeConfiguration({ root = defaultRoot, input } = {}) {
  const normalized = normalizeAiLabRuntimeConfiguration(input);
  const backup = await createConfigurationSnapshot(root, {
    summary: 'Before switching AI runtime to AI-Lab pre-production',
    planId: 'configure-ai-lab-runtime',
  });
  const documents = await readConfigurationDocuments(root);
  await writeConfigurationDocuments(root, {
    ...documents,
    config: {
      ...documents.config,
      aiRuntime: 'ai-lab',
      aiLabEndpoint: normalized.endpoint,
      aiLabAgentId: normalized.agentId,
      aiLabApiKey: normalized.apiKey,
      aiLabWorkNo: normalized.workNo,
    },
  });
  await chmod(resolve(root, 'config.local.json'), 0o600);
  return {
    configured: true,
    runtime: 'ai-lab',
    endpoint: normalized.endpoint,
    backupId: backup.id,
  };
}

async function readPrivateInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024) throw new Error('Configuration input is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await applyAiLabRuntimeConfiguration({ input: await readPrivateInput() });
  console.log(JSON.stringify(result));
}
