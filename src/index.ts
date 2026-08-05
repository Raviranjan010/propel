import { startServer } from './server';
import { initDbSchema } from './db';
import { generateAndSeedData } from './db/seed';
import { buildAllTopologies } from './services/topologyBuilder';

async function main() {
  console.log('Initializing database schema...');
  await initDbSchema();

  console.log('Seeding synthetic grid network dataset...');
  await generateAndSeedData();

  console.log('Building network topology graphs...');
  await buildAllTopologies();

  console.log('Starting KSPDB SCADA Server...');
  startServer();
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
