import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import { runBufferedProcess } from './process-runner.mjs';

const SAFE_AI_RUNTIME_FAILURE_CODES = new Set([
  'PROCESS_EXIT',
  'PROCESS_TIMEOUT',
  'PROCESS_OUTPUT_LIMIT',
  'PROCESS_STDIN_ERROR',
  'PROCESS_SPAWN_ERROR',
  'PROCESS_TERMINATED',
  'AI_RUNTIME_EMPTY_RESPONSE',
]);

export function safeAiRuntimeFailureCode(error) {
  const code = String(error?.code || '').trim().toUpperCase();
  return SAFE_AI_RUNTIME_FAILURE_CODES.has(code) ? code : 'AI_RUNTIME_EXECUTION_FAILED';
}

const DEFINITIONS = [
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'OpenAI Codex 的无界面执行模式',
    supportsImages: true,
  },
  {
    id: 'qoder',
    label: 'Qoder CLI',
    description: 'Qoder 的非交互 print 模式',
    supportsImages: true,
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy CLI',
    description: '腾讯 CodeBuddy Code 的 headless 模式',
    supportsImages: false,
  },
  {
    id: 'trae',
    label: 'TRAE',
    description: '检测 TRAE App；后台模式需要独立 headless CLI',
    supportsImages: false,
  },
  {
    id: 'ai-lab',
    label: 'AI-Lab Agent（预发）',
    description: '阿里内部 AI-Lab 托管的云端 Agent 运行时',
    supportsImages: false,
    remote: true,
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
  configuredQoderBin = '',
  homeDir = homedir(),
  pathEnv = process.env.PATH || '',
} = {}) {
  return {
    codex: [
      configuredCodexBin,
      ...pathCandidates(['codex'], pathEnv),
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ],
    qoder: [
      configuredQoderBin,
      ...pathCandidates(['qodercli', 'qoderclicn'], pathEnv),
      '/Applications/QoderWork.app/Contents/Resources/bin/qodercli',
      '/Applications/QoderWake CN.app/Contents/Resources/payload/qodercli/qodercli-cn-wake',
      join(homeDir, '.local', 'bin', 'qodercli'),
    ],
    codebuddy: [
      ...pathCandidates(['codebuddy', 'cbc'], pathEnv),
      join(homeDir, '.local', 'bin', 'codebuddy'),
      join(homeDir, '.codebuddy', 'bin', 'codebuddy'),
    ],
    // TRAE's desktop launcher has a `chat` command, but it opens the GUI and
    // does not return an answer to a background caller. Do not report it as a
    // usable James runtime until a stable headless binary is available.
    trae: [
      ...pathCandidates(['trae-cli'], pathEnv),
      join(homeDir, '.local', 'bin', 'trae-cli'),
    ],
  };
}

function defaultInstalledCandidates() {
  return {
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
  configuredQoderBin = '',
  aiLabConfigured = false,
  homeDir = homedir(),
  pathEnv = process.env.PATH || '',
  candidates = defaultCandidates({ configuredCodexBin, configuredQoderBin, homeDir, pathEnv }),
  installedCandidates = defaultInstalledCandidates(),
  isExecutable = executable,
} = {}) {
  return DEFINITIONS.map(definition => {
    if (definition.remote) {
      return {
        ...definition,
        path: '',
        installedPath: '',
        installed: Boolean(aiLabConfigured),
        available: Boolean(aiLabConfigured),
        reason: aiLabConfigured ? '' : '尚未配置 Agent ID、API Key 或 Owner 工号',
      };
    }
    const path = firstExecutable(candidates[definition.id], isExecutable);
    const installedPath = path
      || firstExecutable(installedCandidates[definition.id], isExecutable);
    const available = Boolean(path) && definition.id !== 'trae';
    let reason = '';
    if (!installedPath) reason = '本机未安装';
    else if (definition.id === 'trae' && !available) {
      reason = 'TRAE 已安装，但 App 启动器没有可供后台读取的 headless 输出接口';
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
  if (requested === 'online-first') {
    const selected = runtimes.find(item => item.id === 'ai-lab' && item.available);
    if (!selected) throw new Error('AI runtime online-first is not available: AI-Lab is not configured');
    return selected;
  }
  if (requested === 'auto') {
    const selected = ['codex', 'qoder', 'codebuddy', 'trae']
      .map(id => runtimes.find(item => item.id === id && item.available))
      .find(Boolean);
    if (!selected) throw new Error('No supported headless AI runtime is available');
    return selected;
  }
  const selected = runtimes.find(item => item.id === requested);
  if (!selected) throw new Error(`Unknown AI runtime: ${requested}`);
  if (!selected.available) throw new Error(`AI runtime ${requested} is not available: ${selected.reason}`);
  return selected;
}

// Codex runs with `--sandbox read-only`, so it may read files but never write or
// execute. Qoder has no OS-level sandbox, so the same posture is expressed by
// restricting it to the read-only built-in tools.
const QODER_READONLY_TOOLS = ['Read', 'Grep', 'Glob'];

function messageText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => item && (item.type === 'text' || typeof item.text === 'string'))
    .map(item => String(item.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function aiLabAssistantText(payload) {
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
    : Array.isArray(payload?.values?.messages)
      ? payload.values.messages
      : [];
  return [...messages]
    .reverse()
    .filter(message => message?.role === 'assistant')
    .map(message => messageText(message.content))
    .find(Boolean) || '';
}

export function hasAiLabRuntimeConfiguration(value = {}) {
  return [
    value.aiLabEndpoint,
    value.aiLabAgentId,
    value.aiLabApiKey,
    value.aiLabWorkNo,
  ].every(item => Boolean(String(item || '').trim()));
}

export function normalizeAiLabRuntimeConfiguration(value = {}) {
  const endpointValue = String(value.endpoint || '').trim();
  let endpoint;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Error('AI-Lab runtime requires a valid HTTPS endpoint');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) {
    throw new Error('AI-Lab runtime requires an HTTPS endpoint without credentials, query, or fragment');
  }
  const normalized = {
    endpoint: endpoint.href.replace(/\/$/, ''),
    agentId: String(value.agentId || '').trim(),
    apiKey: String(value.apiKey || '').trim(),
    workNo: String(value.workNo || '').trim(),
  };
  if (!/^agt_[A-Za-z0-9]{6,64}$/.test(normalized.agentId)) {
    throw new Error('AI-Lab Agent ID is invalid');
  }
  if (!/^ak-[A-Za-z0-9][A-Za-z0-9_-]{7,255}$/.test(normalized.apiKey)) {
    throw new Error('AI-Lab API Key is invalid');
  }
  if (!/^\d{4,20}$/.test(normalized.workNo)) {
    throw new Error('AI-Lab owner work number is invalid');
  }
  return normalized;
}

export function buildAiRuntimeInvocation(runtime, {
  cwd,
  model = '',
  images = [],
  configDir = '',
} = {}) {
  if (!runtime?.available || !runtime.path) {
    throw new Error('A usable AI runtime is required');
  }
  if (!cwd) throw new Error('AI runtime working directory is required');
  const safeImages = Array.isArray(images) ? images.filter(Boolean) : [];
  if (safeImages.length && !runtime.supportsImages) {
    throw new Error(`${runtime.label} does not support image attachments in James`);
  }
  if (runtime.id === 'codex') {
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
  if (runtime.id === 'qoder') {
    const args = ['-p'];
    // An isolated config directory keeps the service off the operator's
    // interactive Qoder home, mirroring Codex's `--ignore-user-config`.
    if (configDir) args.push('--config-dir', configDir, '--strict-mcp-config');
    args.push(
      '--permission-mode', 'dont_ask',
      '--tools', ...QODER_READONLY_TOOLS,
      '--output-format', 'text',
      '-w', cwd,
    );
    if (model) args.push('-m', model);
    for (const image of safeImages) args.push('--attachment', image);
    return { command: runtime.path, args };
  }
  if (runtime.id === 'codebuddy') {
    const args = [
      '-p',
      '--permission-mode', 'dontAsk',
      '--output-format', 'text',
    ];
    if (model) args.push('--model', model);
    return { command: runtime.path, args };
  }
  throw new Error(`${runtime.label} does not have a safe James headless adapter`);
}

export class AiRuntimeClient {
  constructor({
    runtime,
    runner = runBufferedProcess,
    env = process.env,
    configDir = '',
    aiLab = {},
    fetchImpl = globalThis.fetch,
  }) {
    this.runtime = runtime;
    this.runner = runner;
    this.env = env;
    this.configDir = configDir;
    this.aiLab = aiLab;
    this.fetchImpl = fetchImpl;
  }

  async runAiLab(prompt, { timeoutMs = 120_000 } = {}) {
    const endpoint = String(this.aiLab.endpoint || '').replace(/\/$/, '');
    const agentId = String(this.aiLab.agentId || '');
    const apiKey = String(this.aiLab.apiKey || '');
    const workNo = String(this.aiLab.workNo || '');
    if (!endpoint || !agentId || !apiKey || !workNo || typeof this.fetchImpl !== 'function') {
      throw new Error('AI-Lab Agent failed: CONFIGURATION_MISSING');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(`${endpoint}/api/runs/wait`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          buc_user: JSON.stringify({ workNo }),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          agent_id: agentId,
          input: { messages: [{ role: 'user', content: String(prompt) }] },
          if_not_exists: 'create',
          on_disconnect: 'continue',
          app_source: 'BACKEND',
          metadata: { source: 'aipr0s' },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`AI-Lab Agent failed: HTTP_${response.status}`);
      }
      const payload = await response.json();
      if (payload?.run?.status !== 'success') {
        throw new Error(`AI-Lab Agent failed: REMOTE_STATUS_${String(payload?.run?.status || 'UNKNOWN').toUpperCase()}`);
      }
      const text = aiLabAssistantText(payload);
      if (!text) throw new Error('AI-Lab Agent failed: AI_RUNTIME_EMPTY_RESPONSE');
      return { text, stdout: text, stderr: '', runtime: this.runtime };
    } catch (error) {
      if (String(error?.message || '').startsWith('AI-Lab Agent failed:')) throw error;
      const code = error?.name === 'AbortError' ? 'PROCESS_TIMEOUT' : 'NETWORK_ERROR';
      throw new Error(`AI-Lab Agent failed: ${code}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async run(prompt, {
    cwd,
    model = '',
    images = [],
    configDir = this.configDir,
    timeoutMs = 120_000,
    maxStdoutBytes = 512 * 1024,
    maxStderrBytes = 1024 * 1024,
  } = {}) {
    const input = String(prompt || '');
    if (!input.trim()) throw new Error('AI runtime prompt is required');
    if (this.runtime?.id === 'ai-lab') {
      return this.runAiLab(input, { timeoutMs });
    }
    const invocation = buildAiRuntimeInvocation(this.runtime, {
      cwd, model, images, configDir,
    });
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
        const error = new Error(`${this.runtime.label} returned an empty response`);
        error.code = 'AI_RUNTIME_EMPTY_RESPONSE';
        throw error;
      }
      return { text, stdout, stderr, runtime: this.runtime };
    } catch (error) {
      throw new Error(`${this.runtime.label} failed: ${safeAiRuntimeFailureCode(error)}`);
    }
  }
}

export async function runAiRuntimeStartupProbe(client, options = {}) {
  if (!client || typeof client.run !== 'function') {
    throw new Error('AI runtime client is required for startup probe');
  }
  const expected = 'AIPR0S_RUNTIME_OK';
  const result = await client.run(`这是启动健康探针。只回复：${expected}`, options);
  if (String(result?.text || '').trim() !== expected) {
    throw new Error('AI runtime startup probe returned an unexpected response');
  }
  return result;
}
