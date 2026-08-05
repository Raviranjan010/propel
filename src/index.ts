import { startServer } from './server';
import { getDb, initDbSchema } from './db';
import { buildAllTopologies } from './services/topologyBuilder';

async function main() {
  await initDbSchema();
  startServer();
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
