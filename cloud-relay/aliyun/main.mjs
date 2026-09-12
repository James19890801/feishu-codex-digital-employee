import { readFile } from 'node:fs/promises';
import { createRelayServer } from './server.mjs';
import { SqliteRelayStore } from './store.mjs';
import { parseParityConfig } from './parity-config.mjs';

const configPath = process.env.RELAY_CONFIG_PATH || '/etc/aipro-wechat-relay/config.json';
const config = JSON.parse(await readFile(configPath, 'utf8'));
const parity = parseParityConfig(config);
for (const name of ['callbackSecret', 'relayToken', 'artifactToken', 'canarySecret']) {
  if (typeof config[name] !== 'string' || config[name].length < 32) {
    throw new Error(`Relay ${name} is missing or too short`);
  }
}
const store = new SqliteRelayStore({
  databasePath: config.databasePath || '/var/lib/aipro-wechat-relay/events.sqlite',
  artifactDirectory: config.artifactDirectory || '/var/lib/aipro-wechat-relay/artifacts',
  parityEncryptionKey: parity.parityEncryptionKey,
});
const server = createRelayServer({ ...config, parityToken: parity.parityToken, store });
server.listen(17658, '127.0.0.1', () => {
  process.stdout.write('aipro-wechat-relay listening on loopback\n');
});
const cleanup = setInterval(() => {
  store.cleanupArtifacts().catch(() => process.stderr.write('artifact cleanup failed\n'));
}, 60_000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(cleanup);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
