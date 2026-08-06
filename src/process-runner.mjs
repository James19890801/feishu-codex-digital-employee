import { spawn } from 'node:child_process';

const activeProcesses = new Map();

function structuredProcessMessage(value) {
  const output = String(value || '').trim();
  if (!output) return '';
  try {
    const parsed = JSON.parse(output);
    return String(parsed?.error?.message || parsed?.message || '').trim();
  } catch {
    const match = output.match(/"message"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (!match?.[1]) return '';
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  }
}

export function processFailureSummary(error) {
  const stderr = String(error?.stderr || '').trim();
  if (stderr) {
    const structured = structuredProcessMessage(stderr);
    if (structured) return structured.slice(0, 1000);
    const plain = stderr
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim();
    if (plain) return plain.slice(-1000);
  }
  const stdoutMessage = structuredProcessMessage(error?.stdout);
  if (stdoutMessage) return stdoutMessage.slice(0, 1000);
  return String(error?.message || error || 'unknown process failure').slice(0, 1000);
}

function processError(code, message, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

export function runBufferedProcess(command, args = [], options = {}) {
  const {
    cwd,
    env,
    input,
    timeoutMs = 30_000,
    killGraceMs = 2_000,
    maxStdoutBytes = 4 * 1024 * 1024,
    maxStderrBytes = 1024 * 1024,
    completeOnStdout = null,
  } = options;
  const hasInput = input !== undefined && input !== null;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let terminalError = null;
    let forceTimer = null;
    let settled = false;

    const terminate = error => {
      if (settled || terminalError) return;
      terminalError = error;
      child.kill('SIGTERM');
      forceTimer = setTimeout(() => {
        if (!child.killed || child.exitCode === null) child.kill('SIGKILL');
      }, killGraceMs);
      forceTimer.unref?.();
    };
    activeProcesses.set(child, terminate);

    const timeout = setTimeout(() => {
      terminate(processError('PROCESS_TIMEOUT', `process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        terminate(processError('PROCESS_OUTPUT_LIMIT', 'process stdout exceeded limit'));
        return;
      }
      stdoutChunks.push(chunk);
      if (typeof completeOnStdout === 'function') {
        const stdout = Buffer.concat(stdoutChunks).toString();
        let complete = false;
        try { complete = completeOnStdout(stdout); } catch { complete = false; }
        if (complete && !settled) {
          settled = true;
          activeProcesses.delete(child);
          clearTimeout(timeout);
          const stderr = Buffer.concat(stderrChunks).toString();
          resolve({
            stdout,
            stderr,
            exitCode: child.exitCode,
            completedEarly: true,
          });
          child.kill('SIGTERM');
          forceTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          }, killGraceMs);
          forceTimer.unref?.();
          child.stdout.destroy();
          child.stderr.destroy();
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        terminate(processError('PROCESS_OUTPUT_LIMIT', 'process stderr exceeded limit'));
        return;
      }
      stderrChunks.push(chunk);
    });
    if (child.stdin) {
      child.stdin.on('error', error => {
        // A child may legitimately exit before consuming all input. EPIPE must not
        // escape as an unhandled stream error and crash the long-running service.
        if (error?.code !== 'EPIPE') {
          terminate(processError('PROCESS_STDIN_ERROR', error.message, { cause: error }));
        }
      });
    }
    child.once('error', error => {
      if (settled) return;
      terminalError ||= processError('PROCESS_SPAWN_ERROR', error.message, { cause: error });
    });
    child.once('close', (code, signal) => {
      activeProcesses.delete(child);
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();
      if (terminalError) {
        terminalError.stdout = stdout;
        terminalError.stderr = stderr;
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        reject(processError('PROCESS_EXIT', `process exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}`, {
          exitCode: code,
          signal,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });

    if (hasInput) child.stdin.end(input);
  });
}

export function terminateAllBufferedProcesses() {
  let terminated = 0;
  for (const [child, terminate] of activeProcesses) {
    if (child.exitCode !== null) {
      activeProcesses.delete(child);
      continue;
    }
    terminate(processError('PROCESS_TERMINATED', 'process terminated during service shutdown'));
    terminated += 1;
  }
  return terminated;
}
