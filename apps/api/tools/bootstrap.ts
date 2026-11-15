// The bootstrap of an environment (OQ-05 section 9, decision D12): the first Administrator and the four service
// principals, each with a credential. It is a script, not a route: it needs a direct connection to the database (the role
// that applies the migrations), so nobody who can only reach the API can create an Administrator. A protected delivery
// job or an operator runs it once per environment, on a clean database.
//
//   DATABASE_URL=… node tools/bootstrap.ts --environment STAGING --out /path/to/secrets.json [--admin-id ID --admin-name NAME]
//
// Each credential secret exists once. The command writes them to the file that the operator names, which it creates
// with mode 0600 and never overwrites, and prints only identifiers and the path. The database stores only hashes. The
// file belongs in a secret store (GitHub environment secrets, Fly secrets), never in Git: the operator moves each secret
// to its place and deletes the file.
//
// The Administrator has the role Administrator only: no hierarchy gives it the Steward, Researcher or Viewer routes, and
// no role has trading authority. Service credentials carry the operations of the route manifest that each principal may
// call with a credential: the batch and runner principals claim attempts, the deploy principal records releases, and the
// workflows principal reads the system identity and calls the runner. Attempt routes need the capability of a claim.

import { closeSync, fchmodSync, fsyncSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { createPrincipal, grantRole, issueCredential } from '../src/auth/credentials.ts';
import type { Queryable } from '../src/db/database.ts';
import { createPgDatabase } from '../src/db/pg.ts';
import { DEPLOYMENT_ENVIRONMENTS, type DeploymentEnvironment, randomIds } from '../src/env.ts';
import { manifest, SERVICE_KINDS, type ServiceKind } from '../src/manifest.ts';

/** The route ids that a service principal may call with its own credential (the `service` rules of the manifest). */
export function serviceOperations(kind: ServiceKind): string[] {
  return manifest.routes
    .filter((route) => route.auth.some((rule) => rule.kind === 'service' && rule.principals.includes(kind)))
    .map((route) => route.id)
    .sort();
}

export interface IssuedSecret {
  readonly principal_id: string;
  readonly display_name: string;
  readonly principal_kind: 'HUMAN' | 'SERVICE';
  /** The role of a person, or the service kind of a service principal. */
  readonly authority: string;
  readonly operations?: readonly string[];
  readonly credential_id: string;
  /** The credential as it is presented. It is shown here once and stored nowhere. */
  readonly token: string;
}

export interface BootstrapOptions {
  readonly environment: DeploymentEnvironment;
  readonly adminId: string;
  readonly adminName: string;
  readonly now: Date;
}

/**
 * Create the principals and credentials in the caller's transaction. Refuses an environment that has a principal
 * already: the bootstrap is the start of an environment, not a way to add an Administrator later.
 */
export async function bootstrapEnvironment(tx: Queryable, options: BootstrapOptions): Promise<IssuedSecret[]> {
  const existing = await tx.query('SELECT 1 FROM principals WHERE environment = $1 LIMIT 1', [options.environment]);
  if (existing.rows.length > 0) {
    throw new Error(`${options.environment} has principals already: the bootstrap runs once, on a clean environment.`);
  }
  const ids = randomIds();
  const issued: IssuedSecret[] = [];
  await createPrincipal(tx, options.now, {
    principalId: options.adminId,
    kind: 'HUMAN',
    displayName: options.adminName,
    environment: options.environment,
  });
  await grantRole(tx, options.now, options.adminId, 'Administrator', null);
  const admin = await issueCredential(tx, ids, options.now, {
    principalId: options.adminId,
    principalKind: 'HUMAN',
    issuedBy: options.adminId,
  });
  issued.push({
    principal_id: options.adminId,
    display_name: options.adminName,
    principal_kind: 'HUMAN',
    authority: 'Administrator',
    credential_id: admin.credentialId,
    token: admin.token,
  });
  for (const kind of SERVICE_KINDS) {
    const principalId = `svc-${options.environment.toLowerCase()}-${kind}`;
    const operations = serviceOperations(kind);
    await createPrincipal(tx, options.now, {
      principalId,
      kind: 'SERVICE',
      serviceKind: kind,
      displayName: `${kind} service principal`,
      environment: options.environment,
    });
    const credential = await issueCredential(tx, ids, options.now, {
      principalId,
      principalKind: 'SERVICE',
      operations,
      issuedBy: options.adminId,
    });
    issued.push({
      principal_id: principalId,
      display_name: `${kind} service principal`,
      principal_kind: 'SERVICE',
      authority: kind,
      operations,
      credential_id: credential.credentialId,
      token: credential.token,
    });
  }
  return issued;
}

/**
 * Run the bootstrap against a database and write the secrets to `outPath`, a new file with mode 0600. The file is made
 * before anything is created and written before the transaction commits: when either step fails the file is removed and
 * nothing exists.
 */
export async function bootstrapToFile(
  connectionString: string,
  outPath: string,
  options: Omit<BootstrapOptions, 'now'>,
): Promise<{ readonly principals: readonly { id: string; authority: string }[]; readonly path: string }> {
  // 'wx': the file must not exist, so a second run cannot replace secrets that were issued before.
  const fd = openSync(outPath, 'wx', 0o600);
  // The mode of a new file is reduced by the umask but never raised: set it exactly.
  fchmodSync(fd, 0o600);
  const db = createPgDatabase(connectionString);
  try {
    const issued = await db.transaction(async (tx) => {
      const secrets = await bootstrapEnvironment(tx, { ...options, now: new Date() });
      const document = {
        note: 'Each token is shown here once. Move it to its secret store and delete this file. Never commit it.',
        environment: options.environment,
        issued_at: new Date().toISOString(),
        credentials: secrets,
      };
      writeSync(fd, `${JSON.stringify(document, null, 2)}\n`);
      fsyncSync(fd);
      return secrets;
    });
    closeSync(fd);
    return {
      principals: issued.map((entry) => ({ id: entry.principal_id, authority: entry.authority })),
      path: outPath,
    };
  } catch (error) {
    closeSync(fd);
    unlinkSync(outPath);
    throw error;
  } finally {
    await db.close();
  }
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const connectionString = process.env.DATABASE_URL;
  const environment = option(args, '--environment');
  const out = option(args, '--out');
  if (!connectionString || environment === undefined || out === undefined) {
    console.error(
      'Usage: DATABASE_URL=<direct connection> node tools/bootstrap.ts --environment <DEVELOPMENT|STAGING|PRODUCTION> --out <new file> [--admin-id ID] [--admin-name NAME]',
    );
    process.exit(2);
  }
  if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(environment)) {
    console.error('The environment must be DEVELOPMENT, STAGING or PRODUCTION.');
    process.exit(2);
  }
  const result = await bootstrapToFile(connectionString, out, {
    environment: environment as DeploymentEnvironment,
    adminId: option(args, '--admin-id') ?? 'admin-1',
    adminName: option(args, '--admin-name') ?? 'Administrator',
  });
  for (const principal of result.principals) console.log(`created ${principal.id} (${principal.authority})`);
  console.log(
    `The credentials are in ${result.path}, readable by its owner only. Move them to the secret stores and delete the file.`,
  );
}

// Only the command line runs main: a test imports the functions above.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
