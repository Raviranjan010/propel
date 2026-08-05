import { getDb, initDbSchema } from './index';

async function run() {
  console.log('Initializing database schema...');
  await initDbSchema();
  const db = await getDb();
  const res = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name;
  `);
  console.log('Successfully created PostgreSQL tables:');
  console.table(res.rows);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Error initializing schema:', err);
    process.exit(1);
  });
}
