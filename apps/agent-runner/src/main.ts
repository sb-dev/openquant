// Entry point of the agent runner: read the configuration, listen for dispatches, stop cleanly.
//
// Started as a program, it serves `POST /v1/agent-attempts`. Imported, it does nothing. Execution is off unless
// `AGENT_RUNNER_ENABLED=true`; a disabled runner still claims and records `denied_capability` (OQ-03 section 3).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpApiClient } from './api-client.ts';
import type { Logger } from './attempt.ts';
import { loadConfig } from './config.ts';
import { Runner } from './runner.ts';
import { createDispatchServer } from './server.ts';
import { sha256Bytes } from './text.ts';

export const RUNNER_NAME = 'openquant-agent-runner';
export const RUNNER_VERSION = '0.0.0';

/** One JSON line per event on standard error. It carries identifiers and codes, never a credential or a payload. */
export const jsonLog: Logger = (event, fields) => {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
};

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const file = fileURLToPath(import.meta.url);
  const loaded = loadConfig(env, {
    identity: { name: RUNNER_NAME, version: RUNNER_VERSION, digest: sha256Bytes(readFileSync(file)) },
    defaultBundleDir: resolve(dirname(file), 'bundle'),
  });
  if (!loaded.ok) {
    for (const error of loaded.errors) process.stderr.write(`configuration: ${error}\n`);
    return 2;
  }
  const { config } = loaded;
  const runner = new Runner({
    config,
    api: new HttpApiClient({
      baseUrl: config.api.baseUrl,
      credential: config.api.credential,
      timeoutMs: config.api.timeoutMs,
    }),
    log: jsonLog,
  });
  const server = createDispatchServer({ runner, dispatchToken: config.dispatchToken, log: jsonLog });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(config.listen.port, config.listen.host, resolveListening);
  });
  jsonLog('listening', {
    host: config.listen.host,
    port: config.listen.port,
    environment: config.environment,
    execution_enabled: config.enabled,
    worker: config.workerId,
  });
  const stop = async () => {
    server.close();
    // Every process tree ends and nothing is posted: the leases expire and recovery fences new attempts.
    await runner.shutdown();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return 0;
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) process.exit(code);
}
