// Vitest global setup: one PostgreSQL server for the whole run (tools/test-database.ts), and one migrated template
// database from which every test file copies its own database. The migration runner itself builds the template, so
// the template is the schema that production gets.

import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../tools/migrations.ts';
import { provisionTestDatabase } from '../../tools/test-database.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseAdminUrl: string;
    templateDatabase: string;
  }
}

export function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.href;
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const cluster = await provisionTestDatabase();
  const template = `oq_template_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: cluster.adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${template}`);
    await migrate(withDatabase(cluster.adminUrl, template));
  } catch (error) {
    await admin.end();
    await cluster.stop();
    throw error;
  }
  project.provide('databaseAdminUrl', cluster.adminUrl);
  project.provide('templateDatabase', template);
  return async () => {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`);
    } finally {
      await admin.end();
      await cluster.stop();
    }
  };
}
