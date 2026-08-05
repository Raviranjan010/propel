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
  
  const candidatePaths = [
    path.join(__dirname, 'schema.sql'),
    path.join(process.cwd(), 'src', 'db', 'schema.sql'),
    path.join(process.cwd(), 'dist', 'db', 'schema.sql'),
    path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql')
  ];

  let schemaSql = '';
  let loadedPath = '';

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      schemaSql = fs.readFileSync(p, 'utf-8');
      loadedPath = p;
      break;
    }
  }

  if (!schemaSql) {
    throw new Error(`schema.sql not found in candidate locations: ${candidatePaths.join(', ')}`);
  }

  const statements = schemaSql
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const statement of statements) {
    await db.query(statement);
  }
}
