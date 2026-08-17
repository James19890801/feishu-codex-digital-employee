export function createShutdownGuard({
  timeoutMs = 15_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  forceExit = code => process.exit(code),
  log = message => console.error(message),
} = {}) {
  const effectiveTimeoutMs = Math.max(1_000, Number(timeoutMs) || 15_000);
  let timer = null;
  let active = false;
  let fired = false;
  let shutdownSignal = '';

  return {
    start(signal = 'unknown') {
      if (timer) return false;
      active = true;
      shutdownSignal = String(signal || 'unknown');
      timer = setTimeoutImpl(() => {
        if (!active || fired) return;
        fired = true;
        active = false;
        log(`[bridge] shutdown timed out after ${effectiveTimeoutMs}ms (${shutdownSignal}); forcing exit`);
        forceExit(1);
      }, effectiveTimeoutMs);
      timer?.unref?.();
      return true;
    },
    complete() {
      active = false;
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    },
  };
}
