import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { emptyWechatReliabilityState } from './wechat-reliability-policy.mjs';

const SAFE_VALUE = /^[A-Za-z0-9_.:-]{1,80}$/;

export function resolveWechatReliabilityPaths(home = process.env.AIPRO_HOME) {
  const resolvedHome = String(home || join(homedir(), 'Library', 'Application Support', 'AIPRO'));
  return {
    home: resolvedHome,
    statePath: join(resolvedHome, 'data', 'wechat-reliability-state.json'),
    eventsPath: join(resolvedHome, 'logs', 'wechat-reliability-events.jsonl'),
  };
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  await writeFile(temporaryPath, content, { mode: 0o600, flag: 'wx' });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

function validState(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.state === 'string'
    && value.layers
    && typeof value.layers === 'object';
}

function safeValue(value, fallback) {
  const candidate = String(value ?? '');
  return SAFE_VALUE.test(candidate) ? candidate : fallback;
}

function sanitizeEvent(event, nowMs) {
  const elapsedMs = Number(event?.elapsedMs);
  return {
    at: Number.isFinite(Date.parse(String(event?.at || '')))
      ? new Date(String(event.at)).toISOString()
      : new Date(nowMs).toISOString(),
    layer: safeValue(event?.layer, 'unknown'),
    action: safeValue(event?.action, 'unknown'),
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0,
    result: safeValue(event?.result, 'unknown'),
    errorCode: event?.errorCode == null ? null : safeValue(event.errorCode, 'redacted_error'),
  };
}

export class WechatReliabilityStore {
  constructor({
    home,
    statePath,
    eventsPath,
    now = Date.now,
    maxEvents = 2_000,
    maxEventBytes = 2 * 1024 * 1024,
  } = {}) {
    const paths = resolveWechatReliabilityPaths(home);
    this.statePath = statePath || paths.statePath;
    this.eventsPath = eventsPath || paths.eventsPath;
    this.now = now;
    this.maxEvents = Math.max(1, Math.min(2_000, Number(maxEvents) || 2_000));
    this.maxEventBytes = Math.max(256, Number(maxEventBytes) || 2 * 1024 * 1024);
    this.eventTail = Promise.resolve();
  }

  async load() {
    let text;
    try {
      text = await readFile(this.statePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyWechatReliabilityState(this.now());
      throw error;
    }
    try {
      const state = JSON.parse(text);
      if (!validState(state)) throw new Error('invalid reliability state');
      return state;
    } catch {
      const quarantinePath = `${this.statePath}.corrupt-${this.now()}-${process.pid}`;
      await rename(this.statePath, quarantinePath);
      const replacement = emptyWechatReliabilityState(this.now());
      await this.save(replacement);
      return replacement;
    }
  }

  async save(state) {
    if (!validState(state)) throw new Error('Wechat reliability state is invalid');
    await atomicWrite(this.statePath, `${JSON.stringify(state)}\n`);
  }

  appendEvent(event) {
    const operation = this.eventTail.then(async () => {
      let existing = '';
      try {
        existing = await readFile(this.eventsPath, 'utf8');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const events = existing.split('\n')
        .filter(Boolean)
        .flatMap(line => {
          try {
            const parsed = JSON.parse(line);
            return [sanitizeEvent(parsed, this.now())];
          } catch {
            return [];
          }
        });
      events.push(sanitizeEvent(event, this.now()));
      if (events.length > this.maxEvents) events.splice(0, events.length - this.maxEvents);
      let content = events.map(item => JSON.stringify(item)).join('\n');
      if (content) content += '\n';
      while (events.length && Buffer.byteLength(content) > this.maxEventBytes) {
        events.shift();
        content = events.map(item => JSON.stringify(item)).join('\n');
        if (content) content += '\n';
      }
      await atomicWrite(this.eventsPath, content);
    });
    this.eventTail = operation.catch(() => {});
    return operation;
  }
}
