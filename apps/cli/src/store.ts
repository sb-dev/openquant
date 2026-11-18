// Local files of the CLI (OQ-05 sections 8 and 9). The credentials file holds a person's long-lived credential and
// the current 15-minute access token: it is created with mode 0600 in a 0700 directory, written whole through a
// temporary file of the same mode, and refused when another user can read it. The journal keeps each command whose
// outcome is UNKNOWN, with its exact request, so that `openquant command resolve` can settle it with the same command ID
// and body. No credential or token is ever printed, logged or put in an error message.

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRouteId } from '@openquant/api-client';
import type { CommandRequest } from '@openquant/api-contracts';
import type { ApiEnvironment } from './context.ts';

export interface StoredSession {
  readonly schema: 'openquant-cli-credentials/1';
  readonly api_url: string;
  readonly environment: ApiEnvironment;
  readonly principal: { readonly id: string; readonly display_name: string };
  readonly roles: readonly string[];
  readonly credential: string;
  readonly access_token: string;
  readonly access_token_expires_at: string;
}

export interface PendingCommand {
  readonly schema: 'openquant-cli-pending/1';
  readonly route: CommandRouteId;
  readonly params: Readonly<Record<string, string>>;
  readonly request: CommandRequest;
}

/** A local file problem. Its message names the path and the problem, never the file's contents. */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** The configuration directory: OPENQUANT_CONFIG_DIR, else $XDG_CONFIG_HOME/openquant, else ~/.config/openquant. */
export function configDirectory(env: Readonly<Record<string, string | undefined>>): string {
  if (env.OPENQUANT_CONFIG_DIR) return env.OPENQUANT_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'openquant');
  if (env.HOME) return join(env.HOME, '.config', 'openquant');
  throw new StoreError('Set OPENQUANT_CONFIG_DIR or HOME: the CLI needs a directory for its credentials.');
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new StoreError(`${path} is not a directory.`);
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/** Write a private file whole: a temporary file with mode 0600, then a rename over the target. */
function writePrivate(path: string, text: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Read a private file, or undefined when it does not exist. A file that others can read or write is refused. */
function readPrivate(path: string): string | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile()) throw new StoreError(`${path} is not a regular file.`);
  if ((stat.mode & 0o077) !== 0) {
    throw new StoreError(
      `${path} has mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}: other users can reach it. Run chmod 600 on it, or log in again.`,
    );
  }
  return readFileSync(path, 'utf8');
}

export class Store {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  get credentialsPath(): string {
    return join(this.directory, 'credentials.json');
  }

  get pendingDirectory(): string {
    return join(this.directory, 'pending');
  }

  readSession(): StoredSession | undefined {
    const text = readPrivate(this.credentialsPath);
    if (text === undefined) return undefined;
    let value: Partial<StoredSession>;
    try {
      value = JSON.parse(text) as Partial<StoredSession>;
    } catch {
      throw new StoreError(`${this.credentialsPath} is not valid JSON. Log in again.`);
    }
    if (
      value.schema !== 'openquant-cli-credentials/1' ||
      typeof value.api_url !== 'string' ||
      typeof value.credential !== 'string' ||
      typeof value.access_token !== 'string' ||
      typeof value.access_token_expires_at !== 'string'
    ) {
      throw new StoreError(`${this.credentialsPath} is not a credentials file of this CLI. Log in again.`);
    }
    return value as StoredSession;
  }

  writeSession(session: StoredSession): void {
    ensureDirectory(this.directory);
    writePrivate(this.credentialsPath, `${JSON.stringify(session, null, 2)}\n`);
  }

  /** Remove the credentials file. True when one existed. */
  removeSession(): boolean {
    try {
      rmSync(this.credentialsPath);
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return false;
      throw error;
    }
  }

  #pendingPath(commandId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(commandId)) throw new StoreError('That is not a command ID.');
    return join(this.pendingDirectory, `${commandId}.json`);
  }

  recordPending(pending: PendingCommand): void {
    ensureDirectory(this.directory);
    ensureDirectory(this.pendingDirectory);
    writePrivate(this.#pendingPath(pending.request.command_id), `${JSON.stringify(pending, null, 2)}\n`);
  }

  readPending(commandId: string): PendingCommand | undefined {
    const text = readPrivate(this.#pendingPath(commandId));
    if (text === undefined) return undefined;
    const value = JSON.parse(text) as PendingCommand;
    if (value.schema !== 'openquant-cli-pending/1' || value.request?.command_id !== commandId) {
      throw new StoreError(`The journal entry of ${commandId} is not valid.`);
    }
    return value;
  }

  removePending(commandId: string): void {
    rmSync(this.#pendingPath(commandId), { force: true });
  }

  /** IDs of the commands whose outcome is still unknown. */
  pendingIds(): string[] {
    try {
      return readdirSync(this.pendingDirectory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length))
        .sort();
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return [];
      throw error;
    }
  }
}
