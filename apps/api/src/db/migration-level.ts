// The migration level: the id of the last applied migration (OQ-05 section 11 binds it into the release identity).
// The runner in tools/migrations.ts writes schema_migrations; the API only reads it.

import { ApiFailure } from '../errors.ts';
import { type Queryable, sqlState } from './database.ts';

export async function readMigrationLevel(db: Queryable): Promise<string> {
  try {
    const result = await db.query<{ migration_id: string }>(
      'SELECT migration_id FROM schema_migrations ORDER BY migration_id DESC LIMIT 1',
    );
    const level = result.rows[0]?.migration_id;
    if (level !== undefined) return level;
  } catch (error) {
    // 42P01: the table does not exist, so the database was never migrated.
    if (sqlState(error) !== '42P01') throw error;
  }
  throw new ApiFailure('UNAVAILABLE', 'The database has no migration applied.', { retrySafe: false });
}
