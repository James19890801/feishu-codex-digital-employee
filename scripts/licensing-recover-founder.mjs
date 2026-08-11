import { runFounderCli } from './licensing-bootstrap-founder.mjs';

runFounderCli().catch(error => {
  process.stderr.write(`${error?.message || 'Founder recovery failed.'}\n`);
  process.exitCode = 1;
});
