import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const sourcePath = join(here, 'AIPRO.swift');
const installerPath = join(root, 'scripts', 'install-aipro-macos-app.sh');
await access(sourcePath, constants.R_OK);
await access(installerPath, constants.R_OK | constants.X_OK);

const source = await readFile(sourcePath, 'utf8');
assert.match(source, /http:\/\/127\.0\.0\.1:17655\//);
assert.match(source, /com\.local\.feishu-codex-dashboard/);
assert.match(source, /com\.local\.feishu-codex-digital-employee/);
assert.match(source, /com\.local\.aipro-wechat-poc/);
assert.match(source, /WKWebView/);

const bundle = process.env.AIPRO_APP_BUNDLE;
if (bundle) {
  await access(join(bundle, 'Contents', 'MacOS', 'AIPRO'), constants.X_OK);
  await access(join(bundle, 'Contents', 'Resources', 'AppIcon.icns'), constants.R_OK);
  const value = key => execFileSync('/usr/libexec/PlistBuddy', [
    '-c', `Print :${key}`, join(bundle, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim();
  assert.equal(value('CFBundleIdentifier'), 'com.aipro.digitalemployee');
  assert.equal(value('CFBundleDisplayName'), 'AIPRO');
  assert.equal(value('CFBundleExecutable'), 'AIPRO');
}

console.log('AIPRO_MACOS_APP_BUNDLE_TEST_OK');
