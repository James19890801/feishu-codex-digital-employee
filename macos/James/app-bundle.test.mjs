import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const sourcePath = join(here, 'James.swift');
const transcriberSourcePath = join(here, 'JamesTranscribe.swift');
const installerPath = join(root, 'scripts', 'install-james-macos-app.sh');
await access(sourcePath, constants.R_OK);
await access(transcriberSourcePath, constants.R_OK);
await access(installerPath, constants.R_OK | constants.X_OK);

const source = await readFile(sourcePath, 'utf8');
const installer = await readFile(installerPath, 'utf8');
assert.match(source, /http:\/\/127\.0\.0\.1:17655\//);
assert.match(source, /com\.local\.feishu-codex-dashboard/);
assert.match(source, /com\.local\.feishu-codex-digital-employee/);
assert.match(source, /com\.local\.james-wechat-poc/);
assert.match(source, /WKWebView/);
assert.match(
  source,
  /func applicationShouldHandleReopen\(_ sender: NSApplication, hasVisibleWindows flag: Bool\) -> Bool/,
  'clicking the Dock icon while James is already running must be handled',
);
assert.match(installer, /JamesTranscribe\.swift/);
assert.match(installer, /Contents\/MacOS\/JamesTranscribe/);
assert.match(installer, /show-sdk-version/);
assert.match(
  source,
  /private func openDashboardInBrowser\(\)[\s\S]*OpenConfiguration\(\)[\s\S]*activates = true[\s\S]*withApplicationAt[\s\S]*NSApp\.terminate/,
  'the launcher must activate the default browser and then exit cleanly',
);
assert.match(
  source,
  /func applicationDidBecomeActive\(_ notification: Notification\)[\s\S]*openDashboardInBrowser\(\)/,
  'activating a running windowless James app must reopen the dashboard',
);

const bundle = process.env.JAMES_APP_BUNDLE;
if (bundle) {
  await access(join(bundle, 'Contents', 'MacOS', 'James'), constants.X_OK);
  if (process.env.JAMES_EXPECT_TRANSCRIBER === '1') {
    await access(join(bundle, 'Contents', 'MacOS', 'JamesTranscribe'), constants.X_OK);
  }
  await access(join(bundle, 'Contents', 'Resources', 'AppIcon.icns'), constants.R_OK);
  const value = key => execFileSync('/usr/libexec/PlistBuddy', [
    '-c', `Print :${key}`, join(bundle, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' }).trim();
  assert.equal(value('CFBundleIdentifier'), 'com.james.digitalemployee');
  assert.equal(value('CFBundleDisplayName'), 'James');
  assert.equal(value('CFBundleExecutable'), 'James');
}

console.log('JAMES_MACOS_APP_BUNDLE_TEST_OK');
