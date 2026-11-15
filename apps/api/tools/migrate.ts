// Command line of the migration runner: `pnpm --filter @openquant/api run migrate [-- --status]`.
//
// It reads DATABASE_URL, which must be a direct connection (not a pooled one), applies the pending migrations in
// order and prints the ids and the migration level. It never prints the connection string.

import { migrate, migrationStatus } from './migrations.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Set it to a direct connection string of the target database.');
  process.exit(2);
}

const statusOnly = process.argv.includes('--status');
try {
  if (statusOnly) {
    const status = await migrationStatus(connectionString);
    for (const row of status.applied) console.log(`applied ${row.id}`);
    for (const id of status.pending) console.log(`pending ${id}`);
    console.log(`migration level: ${status.level ?? 'none'}`);
  } else {
    const report = await migrate(connectionString);
    for (const id of report.applied) console.log(`applied ${id}`);
    console.log(report.applied.length === 0 ? 'Nothing to apply.' : `Applied ${report.applied.length} migrations.`);
    console.log(`migration level: ${report.level ?? 'none'}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
