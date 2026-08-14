import { resolve } from 'node:path';
import { AgentState } from '../src/state.mjs';
import { applyAcceptedLearning } from '../src/learning-application.mjs';

function statePathFromArgs(argv) {
  const index = argv.indexOf('--state');
  if (index < 0) return resolve('data/agent-state.sqlite');
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--state requires a path');
  return resolve(value);
}

let state;
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  state = new AgentState(statePathFromArgs(process.argv.slice(2)));
  const result = applyAcceptedLearning(state, payload);
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
} catch (error) {
  process.stderr.write(`${String(error?.message || error).replace(/[\r\n\0]/g, ' ').slice(0, 1000)}\n`);
  process.exitCode = 1;
} finally {
  state?.close();
}
