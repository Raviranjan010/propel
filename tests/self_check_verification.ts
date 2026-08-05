import { generateAndSeedData } from '../src/db/seed';
import { buildAllTopologies } from '../src/services/topologyBuilder';
import { app } from '../src/server';
import request from 'supertest';
import { getDb } from '../src/db';
import { processTelemetryEvent } from '../src/services/telemetryIngest';
import { loadNetworkTreeFromDb, localizeFaults } from '../src/services/localization';
import { ScheduledOutage } from '../src/services/types';

async function runSelfCheckVerification() {
  console.log('=== KSPDB PART 4 SELF-CHECK EXHAUSTIVE VERIFICATION ===\n');

  // Initialize fresh database & topology graph
  await generateAndSeedData();
  await buildAllTopologies();

  // ITEM 2: Single Span Fault Injection
  console.log('--- ITEM 2: Single Span Fault Injection ---');
  const injectRes1 = await request(app)
    .post('/api/simulator/inject-fault')
    .send({ fault_type: 'SPAN', target_id: 'P-000010' });
  console.log('Inject Output:', JSON.stringify(injectRes1.body));

  const ticketsRes1 = await request(app).get('/api/tickets');
  const activeTickets1 = ticketsRes1.body.filter((t: any) => t.status !== 'CLOSED');
  console.log(`Active Tickets Count: ${activeTickets1.length}`);
  console.log('Ticket Sample:', JSON.stringify(activeTickets1[0], null, 2));

  // ITEM 3: Three Simultaneous Faults (on 3 distinct DTs)
  console.log('\n--- ITEM 3: Three Simultaneous Faults ---');
  await generateAndSeedData();
  await buildAllTopologies();

  await request(app).post('/api/simulator/inject-fault').send({ fault_type: 'SPAN', target_id: 'P-000010' });
  await request(app).post('/api/simulator/inject-fault').send({ fault_type: 'SPAN', target_id: 'P-000200' });
  await request(app).post('/api/simulator/inject-fault').send({ fault_type: 'SPAN', target_id: 'P-000500' });

  const ticketsRes2 = await request(app).get('/api/tickets');
  const activeTickets2 = ticketsRes2.body.filter((t: any) => t.status !== 'CLOSED');
  console.log(`Active Tickets Count for 3 Injections: ${activeTickets2.length}`);
  activeTickets2.forEach((t: any, i: number) => {
    console.log(`Ticket ${i+1}: ID=${t.ticket_id}, DownstreamAsset=${t.downstream_asset_id}, DT=${t.dt_id}, FaultType=${t.fault_type}, PIN=${t.pincode}`);
  });

  // ITEM 4: Heartbeat Timeout / Missing Telemetry (Power Still On)
  console.log('\n--- ITEM 4: Heartbeat Timeout (Power Still On, No power_lost Event) ---');
  await generateAndSeedData();
  await buildAllTopologies();

  const heartbeatRes = await processTelemetryEvent({
    device_id: 'KSPDB-DEV-P-000010',
    pole_id: 'P-000010',
    event: 'heartbeat',
    energized: true,
    ts: new Date().toISOString(),
    seq: 5001
  });
  console.log('Heartbeat Event Process Result:', JSON.stringify(heartbeatRes));

  const ticketsRes3 = await request(app).get('/api/tickets');
  console.log(`Tickets Count after Heartbeat Timeout: ${ticketsRes3.body.length}`);

  // ITEM 5: Scheduled Outage Suppresses Fault Ticket Creation
  console.log('\n--- ITEM 5: Scheduled Outage Suppression ---');
  const tree = await loadNetworkTreeFromDb();
  const db = await getDb();
  const polesRes = await db.query('SELECT * FROM poles');
  const poleStates = new Map();
  for (const p of polesRes.rows) {
    poleStates.set(p.pole_id, { ...p, is_energized: p.dt_id !== 'D-0005' }); // All poles on D-0005 dark
  }

  const scheduledOutages: ScheduledOutage[] = [
    {
      id: 'SO-001',
      scope: 'dt',
      target_id: 'D-0005',
      start_time: new Date(Date.now() - 3600000),
      end_time: new Date(Date.now() + 3600000),
      reason: 'Scheduled maintenance grid upgrade'
    }
  ];

  const localizedFaults = localizeFaults(tree, poleStates, scheduledOutages, 'D-0005');
  console.log(`Faults Localized during Scheduled Outage on D-0005: ${localizedFaults.length}`);

  // ITEM 6: Fault Repair & Telemetry Auto-Verification
  console.log('\n--- ITEM 6: Fault Repair & Auto-Verification ---');
  await generateAndSeedData();
  await buildAllTopologies();

  await request(app).post('/api/simulator/inject-fault').send({ fault_type: 'SPAN', target_id: 'P-000010' });

  const repairStartTime = performance.now();
  const repairRes = await request(app)
    .post('/api/simulator/repair-fault')
    .send({ fault_type: 'SPAN', target_id: 'P-000010' });
  const repairEndTime = performance.now();

  console.log('Repair Response:', JSON.stringify(repairRes.body));
  console.log(`Repair & Auto-Verification Latency: ${(repairEndTime - repairStartTime).toFixed(2)} ms`);

  const ticketsRes4 = await request(app).get('/api/tickets');
  const repairedTicket = ticketsRes4.body.find((t: any) => t.downstream_asset_id === 'P-000010');
  console.log('Repaired Ticket Final State:', JSON.stringify(repairedTicket, null, 2));

  // ITEM 7: Rejection of Manual Closure on Dark Poles
  console.log('\n--- ITEM 7: Verification Rejection on Dark Poles ---');
  await generateAndSeedData();
  await buildAllTopologies();

  await request(app).post('/api/simulator/inject-fault').send({ fault_type: 'SPAN', target_id: 'P-000010' });

  const darkTicketsRes = await request(app).get('/api/tickets');
  const darkTicketId = darkTicketsRes.body[0].ticket_id;

  const verifyRejectRes = await request(app).post(`/api/tickets/${darkTicketId}/verify`);
  console.log(`HTTP Status Code: ${verifyRejectRes.status}`);
  console.log('Rejection Response Body:', JSON.stringify(verifyRejectRes.body, null, 2));

  console.log('\n=== ALL SELF-CHECK VERIFICATION EXERCISES COMPLETE ===');
  process.exit(0);
}

runSelfCheckVerification().catch((err) => {
  console.error('Verification script failed:', err);
  process.exit(1);
});
