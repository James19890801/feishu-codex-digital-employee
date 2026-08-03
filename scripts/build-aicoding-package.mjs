import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildDistribution } from './distribution-package.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const result = await buildDistribution({
  root,
  outputDir: join(root, 'dist'),
  version: packageJson.version,
});
console.log(`PACKAGE_ZIP=${result.archive}`);
console.log(`PACKAGE_FILES=${result.fileCount}`);
console.log(`PACKAGE_BYTES=${result.bytes}`);
console.log(`PACKAGE_SHA256=${result.sha256}`);
