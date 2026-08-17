import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { processFailureSummary, runBufferedProcess } from './process-runner.mjs';

const DEFINITIONS = [
  {
    id: 'workbuddy',
    adapter: 'codebuddy',
    label: 'WorkBuddy',
    description: 'WorkBuddy 的兼容无界面执行模式',
    supportsImages: false,
  },
  {
    id: 'qoder_work',
    adapter: 'qoder',
    label: 'Qoder Work',
    description: 'Qoder Work 内置 CLI 的非交互 print 模式',
    supportsImages: true,
  },
  {
    id: 'qoder',
    adapter: 'qoder',
    label: 'Qoder CLI',
    description: 'Qoder 的非交互 print 模式',
    supportsImages: true,
  },
  {
    id: 'codebuddy',
    adapter: 'codebuddy',
    label: 'CodeBuddy CLI',
    description: 'CodeBuddy Code 的 headless 模式',
    supportsImages: false,
  },
  {
    id: 'codex',
    adapter: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex 的无界面执行模式',
    supportsImages: true,
  },
  {
    id: 'trae',
    label: 'TRAE',
    description: '检测 TRAE App；后台模式需要独立 headless CLI',
    supportsImages: false,
  },
];

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(names, pathEnv = process.env.PATH || '') {
  return pathEnv.split(delimiter)
    .filter(Boolean)
    .flatMap(directory => names.map(name => join(directory, name)));
}

function defaultCandidates({
  configuredCodexBin = '',
  homeDir = homedir(),
  pathEnv = process.env.PATH || '',
} = {}) {
  return {
    workbuddy: [
      ...pathCandidates(['workbuddy-cli', 'workbuddy', 'workbuddy-cli.exe', 'workbuddy.exe'], pathEnv),
      join(homeDir, '.local', 'bin', 'workbuddy-cli'),
    ],
    qoder_work: [
      ...pathCandidates(['qoder-work', 'qoderwork', 'qoder-work.exe', 'qoderwork.exe'], pathEnv),
      '/Applications/QoderWork.app/Contents/Resources/bin/qodercli',
    ],
    qoder: [
      ...pathCandidates(['qodercli', 'qoderclicn', 'qodercli.exe', 'qoderclicn.exe'], pathEnv),
      '/Applications/Qoder.app/Contents/Resources/bin/qodercli',
      '/Applications/QoderWake CN.app/Contents/Resources/payload/qodercli/qodercli-cn-wake',
      join(homeDir, '.local', 'bin', 'qodercli'),
    ],
    codebuddy: [
      ...pathCandidates(['codebuddy', 'cbc', 'codebuddy.exe', 'cbc.exe'], pathEnv),
      join(homeDir, '.local', 'bin', 'codebuddy'),
      join(homeDir, '.codebuddy', 'bin', 'codebuddy'),
    ],
    codex: [
      configuredCodexBin,
      ...pathCandidates(['codex'], pathEnv),
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ],
    // TRAE's desktop launcher has a `chat` command, but it opens the GUI and
    // does not return an answer to a background caller. Do not report it as a
    // usable AIPRO runtime until a stable headless binary is available.
    trae: [
      ...pathCandidates(['trae-cli'], pathEnv),
      join(homeDir, '.local', 'bin', 'trae-cli'),
    ],
  };
}

function defaultInstalledCandidates() {
  return {
    workbuddy: [
      '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
      '/Applications/WorkBuddy.app',
    ],
    trae: [
      '/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn',
      '/Applications/TRAE.app/Contents/Resources/app/bin/trae',
    ],
  };
}

function firstExecutable(paths, isExecutable) {
  return [...new Set((paths || []).filter(Boolean))].find(isExecutable) || '';
}

export function discoverAiRuntimes({
  configuredCodexBin = '',
  homeDir = homedir(),
  pathEnv = process.env.PATH || '',
  candidates = defaultCandidates({ configuredCodexBin, homeDir, pathEnv }),
  installedCandidates = defaultInstalledCandidates(),
  isExecutable = executable,
} = {}) {
  return DEFINITIONS.map(definition => {
    const path = firstExecutable(candidates[definition.id], isExecutable);
    const installedPath = path
      || firstExecutable(installedCandidates[definition.id], isExecutable);
    const available = Boolean(path) && definition.id !== 'trae';
    let reason = '';
    if (!installedPath) reason = '本机未安装';
    else if (!available && ['workbuddy', 'trae'].includes(definition.id)) {
      reason = `${definition.label} 已安装，但未检测到可供后台读取的 headless CLI`;
    }
    return {
      ...definition,
      path,
      installedPath,
      installed: Boolean(installedPath),
      available,
      reason,
    };
  });
}

export function selectAiRuntime(runtimes, preference = 'auto') {
  if (!Array.isArray(runtimes)) throw new Error('AI runtimes are unavailable');
  const requested = String(preference || 'auto');
  if (requested === 'auto') {
    const selected = runtimes.find(item => item.available);
    if (!selected) throw new Error('No supported headless AI runtime is available');
    return selected;
  }
  const selected = runtimes.find(item => item.id === requested);
  if (!selected) throw new Error(`Unknown AI runtime: ${requested}`);
  if (!selected.available) throw new Error(`AI runtime ${requested} is not available: ${selected.reason}`);
  return selected;
}

export function buildAiRuntimeInvocation(runtime, {
  cwd,
  model = '',
  images = [],
} = {}) {
  if (!runtime?.available || !runtime.path) {
    throw new Error('A usable AI runtime is required');
  }
  if (!cwd) throw new Error('AI runtime working directory is required');
  const safeImages = Array.isArray(images) ? images.filter(Boolean) : [];
  if (safeImages.length && !runtime.supportsImages) {
    throw new Error(`${runtime.label} does not support image attachments in AIPRO`);
  }
  const adapter = runtime.adapter || runtime.id;
  if (adapter === 'codex') {
    const args = [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      '--color', 'never',
    ];
    if (model) args.push('-m', model);
    args.push('-C', cwd);
    for (const image of safeImages) args.push('--image', image);
    args.push('-');
    return { command: runtime.path, args };
  }
  if (adapter === 'qoder') {
    const args = [
      '-p',
      '--permission-mode', 'dont_ask',
      '--tools', '',
      '--output-format', 'text',
      '-w', cwd,
    ];
    if (model) args.push('-m', model);
    for (const image of safeImages) args.push('--attachment', image);
    return { command: runtime.path, args };
  }
  if (adapter === 'codebuddy') {
    const args = [
      '-p',
      '--permission-mode', 'dontAsk',
      '--output-format', 'text',
    ];
    if (model) args.push('--model', model);
    return { command: runtime.path, args };
  }
  throw new Error(`${runtime.label} does not have a safe AIPRO headless adapter`);
}

export class AiRuntimeClient {
  constructor({
    runtime,
    runner = runBufferedProcess,
    env = process.env,
  }) {
    this.runtime = runtime;
    this.runner = runner;
    this.env = env;
  }

  async run(prompt, {
    cwd,
    model = '',
    images = [],
    timeoutMs = 120_000,
    maxStdoutBytes = 512 * 1024,
    maxStderrBytes = 1024 * 1024,
  } = {}) {
    const input = String(prompt || '');
    if (!input.trim()) throw new Error('AI runtime prompt is required');
    const invocation = buildAiRuntimeInvocation(this.runtime, { cwd, model, images });
    try {
      const { stdout, stderr } = await this.runner(invocation.command, invocation.args, {
        cwd,
        env: this.env,
        input,
        timeoutMs,
        killGraceMs: 5_000,
        maxStdoutBytes,
        maxStderrBytes,
      });
      const text = String(stdout || '').trim();
      if (!text) {
        throw new Error(`${this.runtime.label} returned an empty response: ${String(stderr || '').slice(-500)}`);
      }
      return { text, stdout, stderr, runtime: this.runtime };
    } catch (error) {
      if (error?.message?.includes('returned an empty response')) throw error;
      throw new Error(`${this.runtime.label} failed: ${processFailureSummary(error)}`);
    }
  }
}
