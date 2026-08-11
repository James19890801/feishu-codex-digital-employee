import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WeChatPocControlStore } from './control-store.mjs';

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function defaultProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class WeChatPocDashboardControl {
  constructor({
    directory,
    now = () => new Date().toISOString(),
    audit = async () => {},
    processAlive = defaultProcessAlive,
  }) {
    if (!directory) throw new Error('WeChat POC dashboard directory is required');
    this.directory = directory;
    this.statusPath = join(directory, 'status.json');
    this.controlStore = new WeChatPocControlStore({ directory, now });
    this.now = now;
    this.audit = audit;
    this.processAlive = processAlive;
  }

  async status() {
    const [control, worker] = await Promise.all([
      this.controlStore.read(),
      readJson(this.statusPath),
    ]);
    const pid = Number(worker?.pid || 0);
    const alive = this.processAlive(pid);
    const queue = worker?.queue && typeof worker.queue === 'object' ? worker.queue : {};
    let state = 'not_installed';
    if (worker) {
      if (!alive) state = 'offline';
      else if (!control.enabled) state = 'disabled';
      else state = ['online', 'degraded', 'uncertain'].includes(worker.state)
        ? worker.state
        : 'starting';
    }
    return {
      version: 1,
      installed: Boolean(worker),
      processAlive: alive,
      pid: alive ? pid : null,
      state,
      control,
      clientRunning: worker?.clientRunning === true,
      permissionState: String(worker?.permissionState || 'unknown'),
      lastReceiveAt: String(worker?.lastReceiveAt || ''),
      lastReplyAt: String(worker?.lastReplyAt || ''),
      lastTickAt: String(worker?.lastTickAt || ''),
      lastAction: String(worker?.lastAction || ''),
      lastError: worker?.lastError || null,
      pending: Number(queue.pending || 0) + Number(queue.processing || 0),
      queue,
      updatedAt: this.now(),
    };
  }

  async setEnabled(enabled, {
    confirmed = false,
    actor = 'local-dashboard',
  } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    if (enabled && confirmed !== true) throw new Error('Enabling confirmation is required');
    const previous = await this.controlStore.read();
    const control = await this.controlStore.setEnabled(enabled, {
      reason: enabled ? 'operator_enabled' : 'operator_disabled',
    });
    await this.audit({
      event: 'wechat_poc_control_changed',
      at: this.now(),
      actor,
      previousEnabled: previous.enabled,
      enabled,
      generation: control.generation,
    });
    return { ok: true, control, status: await this.status() };
  }

  async emergencyStop({ actor = 'local-dashboard' } = {}) {
    const previous = await this.controlStore.read();
    const control = await this.controlStore.failClosed('emergency_stop');
    await this.audit({
      event: 'wechat_poc_emergency_stopped',
      at: this.now(),
      actor,
      previousEnabled: previous.enabled,
      enabled: false,
      generation: control.generation,
    });
    return { ok: true, control, status: await this.status() };
  }
}
