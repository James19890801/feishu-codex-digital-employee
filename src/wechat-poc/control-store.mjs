import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_WECHAT_POC_CONTROL = Object.freeze({
  version: 1,
  enabled: false,
  generation: 0,
  boundaryAt: '',
  updatedAt: '',
  reason: 'not_initialized',
});

function disabledInvalidState() {
  return {
    ...DEFAULT_WECHAT_POC_CONTROL,
    reason: 'invalid_control_state',
  };
}

function validControl(value) {
  return value?.version === 1
    && typeof value.enabled === 'boolean'
    && Number.isSafeInteger(value.generation)
    && value.generation >= 0
    && typeof value.boundaryAt === 'string'
    && typeof value.updatedAt === 'string'
    && typeof value.reason === 'string';
}

export class WeChatPocControlStore {
  constructor({
    directory,
    now = () => new Date().toISOString(),
    fileName = 'control.json',
  }) {
    if (!directory) throw new Error('WeChat POC control directory is required');
    this.directory = directory;
    this.path = join(directory, fileName);
    this.now = now;
  }

  async read() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...DEFAULT_WECHAT_POC_CONTROL };
      return disabledInvalidState();
    }
    try {
      const parsed = JSON.parse(text);
      return validControl(parsed) ? parsed : disabledInvalidState();
    } catch {
      return disabledInvalidState();
    }
  }

  async write(control) {
    if (!validControl(control)) throw new Error('Invalid WeChat POC control state');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(control, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      const { rm } = await import('node:fs/promises');
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return control;
  }

  async initialize({ enabledByDefault = false } = {}) {
    const current = await this.read();
    if (current.reason !== 'not_initialized') return current;
    const timestamp = this.now();
    return this.write({
      version: 1,
      enabled: enabledByDefault === true,
      generation: 1,
      boundaryAt: timestamp,
      updatedAt: timestamp,
      reason: enabledByDefault === true ? 'auto_enabled' : 'initialized_disabled',
    });
  }

  async setEnabled(enabled, { reason = 'operator' } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('WeChat POC enabled must be boolean');
    const previous = await this.read();
    const timestamp = this.now();
    return this.write({
      version: 1,
      enabled,
      generation: previous.generation + 1,
      boundaryAt: timestamp,
      updatedAt: timestamp,
      reason: String(reason || 'operator').slice(0, 120),
    });
  }

  async advanceGeneration(reason = 'worker_boundary') {
    const previous = await this.read();
    const timestamp = this.now();
    return this.write({
      version: 1,
      enabled: previous.enabled,
      generation: previous.generation + 1,
      boundaryAt: timestamp,
      updatedAt: timestamp,
      reason: String(reason || 'worker_boundary').slice(0, 120),
    });
  }

  async failClosed(reason = 'fail_closed') {
    return this.setEnabled(false, { reason });
  }
}
