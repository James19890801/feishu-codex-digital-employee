import { createInterface } from 'node:readline';

export function shouldRetrySupervisor(stopping) {
  return !stopping;
}

function shortDrain(stream, timeoutMs = 50) {
  if (stream.readableEnded || stream.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      stream.off('end', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    stream.once('end', finish);
  });
}

export async function consumeLinesUntilExit(child, onLine) {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const reader = (async () => {
    for await (const line of lines) {
      if (line.trim()) await onLine(line);
    }
  })().catch(error => {
    if (error?.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  await shortDrain(child.stdout);
  lines.close();
  child.stdout.destroy();
  await Promise.race([
    reader,
    new Promise(resolve => setTimeout(resolve, 100)),
  ]);
  return exitCode;
}
