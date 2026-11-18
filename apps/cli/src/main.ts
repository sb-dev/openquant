// The openquant binary (Node 24). It runs one command line and exits with its code (docs/reference/cli.md). Ink
// restores the terminal on exit; SIGINT outside Ink exits with 130.

import { runCli } from './cli.ts';
import { EXIT } from './outcome.ts';

process.once('SIGINT', () => {
  process.exitCode = EXIT.INTERRUPTED;
  process.exit();
});

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
});
