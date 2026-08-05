import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server';
import { generateAndSeedData } from '../src/db/seed';
import { buildAllTopologies } from '../src/services/topologyBuilder';

describe('End-to-End System & API Verification Tests', () => {
  beforeAll(async () => {
    await generateAndSeedData();
    await buildAllTopologies();
  }, 30000);

  it('1. GET /health returns healthy status with loaded poles', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.poles_loaded).toBe(3000);
  });

  it('2. POST /api/telemetry handles ingest, deduplication, and out-of-order seq', async () => {
    const payload = {
      device_id: 'KSPDB-DEV-000001',
      pole_id: 'P-000001',
      event: 'power_lost' as const,
      energized: false,
      ts: new Date().toISOString(),
      seq: 100,
      battery_mv: 3400
    };

    // Initial ingest
    const res1 = await request(app).post('/api/telemetry').send(payload);
    expect(res1.status).toBe(202);
    expect(res1.body.reLocalized).toBe(true);

    // Duplicate ingest (same device_id + seq)
    const res2 = await request(app).post('/api/telemetry').send(payload);
    expect(res2.status).toBe(202);
    expect(res2.body.status).toBe('duplicate_ignored');

    // Out-of-order stale ingest (seq < max_seq)
    const stalePayload = { ...payload, seq: 90, energized: true };
    const res3 = await request(app).post('/api/telemetry').send(stalePayload);
    expect(res3.status).toBe(202);
    expect(res3.body.reLocalized).toBe(false);
  });

  it('3. Simulator injects SPAN fault, generates located ticket with PIN and confidence', async () => {
    const res = await request(app)
      .post('/api/simulator/inject-fault')
      .send({ fault_type: 'SPAN', target_id: 'P-000010' });
    expect(res.status).toBe(200);

    const ticketsRes = await request(app).get('/api/tickets');
    expect(ticketsRes.status).toBe(200);
    const activeTickets = ticketsRes.body.filter((t: any) => t.status !== 'CLOSED');
    expect(activeTickets.length).toBeGreaterThan(0);

    const ticket = activeTickets[0];
    expect(ticket.fault_type).toBe('SPAN');
    expect(ticket.downstream_asset_id).toBe('P-000010');
    expect(ticket.pincode).toBeDefined();
    expect(ticket.confidence).toBeGreaterThan(0);
    expect(['explicit', 'inferred']).toContain(ticket.topology_source);
  });

  it('4. Enforces Ticket Lifecycle and rejects manual verification on dark poles', async () => {
    const ticketsRes = await request(app).get('/api/tickets');
    const activeTicket = ticketsRes.body.find((t: any) => t.status === 'DETECTED');
    expect(activeTicket).toBeDefined();

    const ticketId = activeTicket.ticket_id;

    // Acknowledge
    const ackRes = await request(app).post(`/api/tickets/${ticketId}/acknowledge`);
    expect(ackRes.status).toBe(200);
    expect(ackRes.body.status).toBe('ACKNOWLEDGED');

    // Assign Crew
    const crewRes = await request(app)
      .post(`/api/tickets/${ticketId}/assign-crew`)
      .send({ crew: 'Crew Beta' });
    expect(crewRes.status).toBe(200);
    expect(crewRes.body.status).toBe('CREW_ASSIGNED');

    // Resolve
    const resRes = await request(app).post(`/api/tickets/${ticketId}/resolve`);
    expect(resRes.status).toBe(200);
    expect(resRes.body.status).toBe('RESOLVED');

    // Try manual verification while poles are dark => REJECTED!
    const verifyFail = await request(app).post(`/api/tickets/${ticketId}/verify`);
    expect(verifyFail.status).toBe(400);
    expect(verifyFail.body.error).toBe('TELEMETRY_VERIFICATION_FAILED');
  });

  it('5. Simulator repairs fault => telemetry auto-verifies and closes ticket', async () => {
    const repairRes = await request(app)
      .post('/api/simulator/repair-fault')
      .send({ fault_type: 'SPAN', target_id: 'P-000010' });
    expect(repairRes.status).toBe(200);

    const ticketsRes = await request(app).get('/api/tickets');
    const closedTicket = ticketsRes.body.find((t: any) => t.downstream_asset_id === 'P-000010');
    expect(closedTicket).toBeDefined();
    expect(closedTicket.status).toBe('CLOSED');
    expect(closedTicket.verified_at).not.toBeNull();
  });
});
