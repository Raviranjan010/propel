import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';

let pool: Pool | null = null;
let pgliteInstance: PGlite | null = null;

export async function getDb() {
  if (process.env.DATABASE_URL) {
    if (!pool) {
      pool = new Pool({ connectionString: process.env.DATABASE_URL });
    }
    return {
      query: async (text: string, params?: any[]) => {
        const res = await pool!.query(text, params);
        return { rows: res.rows, rowCount: res.rowCount };
      }
    };
  } else {
    if (!pgliteInstance) {
      const dataDir = process.env.PGDATA_PATH;
      pgliteInstance = dataDir ? new PGlite(dataDir) : new PGlite();
    }
    return {
      query: async (text: string, params?: any[]) => {
        const res = await pgliteInstance!.query(text, params);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      }
    };
  }
}

export async function initDbSchema() {
  const db = await getDb();
  const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  const statements = schemaSql
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    await db.query(statement);
  }
}
