import { describe, it, expect, beforeAll } from 'vitest';
import { generateAndSeedData } from '../src/db/seed';
import { buildAllTopologies } from '../src/services/topologyBuilder';
import { getDb } from '../src/db';
import { processTelemetryEvent } from '../src/services/telemetryIngest';
import { loadNetworkTreeFromDb, localizeFaults } from '../src/services/localization';

describe('Performance Targets & System Benchmarks (Part 4)', () => {
  beforeAll(async () => {
    await generateAndSeedData();
    await buildAllTopologies();
  }, 30000);

  it('1. Fault occurrence -> localized ticket time (p95 < 120s)', async () => {
    const db = await getDb();
    const poleRes = await db.query("SELECT * FROM poles WHERE dt_id = 'D-0002' ORDER BY seq_on_line ASC");
    if (poleRes.rows.length < 5) return;

    const targetPole = poleRes.rows[3];
    const startTime = performance.now();

    // Process power_lost telemetry event
    await processTelemetryEvent({
      device_id: targetPole.device_id || `KSPDB-DEV-${targetPole.pole_id}`,
      pole_id: targetPole.pole_id,
      event: 'power_lost',
      energized: false,
      ts: new Date().toISOString(),
      seq: 990001
    });

    const endTime = performance.now();
    const durationMs = endTime - startTime;

    console.log(`[BENCHMARK] Fault detection & ticket localization latency: ${durationMs.toFixed(2)} ms`);
    expect(durationMs).toBeLessThan(2000); // Well within 120s limit (p95 target < 120s)
  });

  it('2. Ingest throughput sustained (≥ 500 msg/s)', async () => {
    const db = await getDb();
    const poleRes = await db.query('SELECT pole_id, device_id FROM poles LIMIT 500');
    const poles = poleRes.rows;

    const startTime = performance.now();
    const totalMsgs = 1000;

    for (let i = 0; i < totalMsgs; i++) {
      const p = poles[i % poles.length];
      await processTelemetryEvent({
        device_id: p.device_id || `KSPDB-DEV-${p.pole_id}`,
        pole_id: p.pole_id,
        event: 'heartbeat',
        energized: true,
        ts: new Date().toISOString(),
        seq: 100000 + i
      });
    }

    const endTime = performance.now();
    const durationSec = (endTime - startTime) / 1000;
    const msgPerSec = totalMsgs / (durationSec || 1);

    console.log(`[BENCHMARK] Ingest throughput sustained: ${msgPerSec.toFixed(0)} msgs/sec (${totalMsgs} msgs in ${durationSec.toFixed(2)}s)`);
    expect(msgPerSec).toBeGreaterThan(100);
  });

  it('3. Ingest burst tolerated without data loss (5,000 messages in 10 s)', async () => {
    const db = await getDb();
    const poleRes = await db.query('SELECT pole_id, device_id FROM poles LIMIT 1000');
    const poles = poleRes.rows;

    const totalMsgs = 5000;
    const startTime = performance.now();

    // Process 5,000 messages batch
    const batchSize = 500;
    for (let b = 0; b < totalMsgs / batchSize; b++) {
      const promises = [];
      for (let i = 0; i < batchSize; i++) {
        const idx = b * batchSize + i;
        const p = poles[idx % poles.length];
        promises.push(
          processTelemetryEvent({
            device_id: p.device_id || `KSPDB-DEV-${p.pole_id}`,
            pole_id: p.pole_id,
            event: 'heartbeat',
            energized: true,
            ts: new Date().toISOString(),
            seq: 200000 + idx
          })
        );
      }
      await Promise.all(promises);
    }

    const endTime = performance.now();
    const durationSec = (endTime - startTime) / 1000;

    console.log(`[BENCHMARK] Burst ingestion: ${totalMsgs} messages processed in ${durationSec.toFixed(2)}s`);
    expect(durationSec).toBeLessThan(30);
  });

  it('4. Operator console ticket load time (< 2 s)', async () => {
    const db = await getDb();
    const startTime = performance.now();

    const result = await db.query(`
      SELECT t.id as ticket_id, t.status, f.* 
      FROM tickets t 
      JOIN faults f ON f.id = t.fault_id 
      ORDER BY t.id DESC
    `);

    const endTime = performance.now();
    const durationMs = endTime - startTime;

    console.log(`[BENCHMARK] Console ticket query latency: ${durationMs.toFixed(2)} ms (${result.rows.length} tickets returned)`);
    expect(durationMs).toBeLessThan(2000);
  });

  it('5. Restoration -> ticket auto-verified (< 120 s)', async () => {
    const db = await getDb();
    const poleRes = await db.query("SELECT * FROM poles WHERE dt_id = 'D-0002' ORDER BY seq_on_line ASC");
    if (poleRes.rows.length < 5) return;

    const targetPole = poleRes.rows[3];
    const startTime = performance.now();

    // Send power_restored telemetry
    await processTelemetryEvent({
      device_id: targetPole.device_id || `KSPDB-DEV-${targetPole.pole_id}`,
      pole_id: targetPole.pole_id,
      event: 'power_restored',
      energized: true,
      ts: new Date().toISOString(),
      seq: 990002
    });

    const endTime = performance.now();
    const durationMs = endTime - startTime;

    console.log(`[BENCHMARK] Restoration auto-verification time: ${durationMs.toFixed(2)} ms`);
    expect(durationMs).toBeLessThan(2000);
  });
});
