import { getDb } from '../db';
import { loadNetworkTreeFromDb, localizeFaults } from './localization';
import { PoleState, ScheduledOutage } from './types';
import { generateDispatchBriefing } from './aiCopilot';

export interface TelemetryPayload {
  device_id: string;
  pole_id: string;
  event: 'heartbeat' | 'power_lost' | 'power_restored' | 'boot';
  energized: boolean;
  ts: string;
  seq: number;
  battery_mv?: number;
  rssi?: number;
  fw?: string;
}

export async function processTelemetryEvent(payload: TelemetryPayload): Promise<{ status: string; reLocalized: boolean; affectedDtId?: string }> {
  const db = await getDb();

  // 1. Check deduplication on (device_id, seq)
  const existingRes = await db.query(
    'SELECT id FROM telemetry_events WHERE device_id = $1 AND seq = $2',
    [payload.device_id, payload.seq]
  );

  if (existingRes.rows.length > 0) {
    return { status: 'duplicate_ignored', reLocalized: false };
  }

  // Record telemetry event in telemetry_events log table
  await db.query(
    `INSERT INTO telemetry_events (device_id, pole_id, event, energized, ts, seq, battery_mv, rssi, fw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      payload.device_id,
      payload.pole_id,
      payload.event,
      payload.energized,
      payload.ts,
      payload.seq,
      payload.battery_mv ?? null,
      payload.rssi ?? null,
      payload.fw ?? null
    ]
  );

  // 2. Fetch pole details
  const poleRes = await db.query('SELECT * FROM poles WHERE pole_id = $1', [payload.pole_id]);
  if (poleRes.rows.length === 0) {
    return { status: 'pole_not_found', reLocalized: false };
  }
  const pole = poleRes.rows[0];
  const dtId = pole.dt_id;

  // 3. Out-of-order tolerance: check if payload.seq is smaller than existing max seq for device
  const maxSeqRes = await db.query(
    'SELECT MAX(seq) as max_seq FROM telemetry_events WHERE device_id = $1',
    [payload.device_id]
  );
  const maxSeq = maxSeqRes.rows[0]?.max_seq ?? 0;

  let stateChanged = false;
  if (payload.seq >= maxSeq) {
    // Current event is the latest, update pole energized status
    if (pole.is_energized !== payload.energized) {
      stateChanged = true;
      await db.query(
        'UPDATE poles SET is_energized = $1, last_event_ts = $2 WHERE pole_id = $3',
        [payload.energized, payload.ts, payload.pole_id]
      );
    }
  }

  // 4. On any state change, re-run localization for affected DT only
  if (stateChanged) {
    await syncFaultsAndTicketsForDt(dtId);
    return { status: 'processed_state_changed', reLocalized: true, affectedDtId: dtId };
  }

  return { status: 'processed_no_state_change', reLocalized: false, affectedDtId: dtId };
}

export async function syncFaultsAndTicketsForDt(dtId: string) {
  const db = await getDb();

  // Load network tree and current pole states
  const tree = await loadNetworkTreeFromDb();
  const polesRes = await db.query('SELECT * FROM poles');
  const poleStates = new Map<string, PoleState>();
  for (const p of polesRes.rows) {
    poleStates.set(p.pole_id, {
      pole_id: p.pole_id,
      lat: p.lat,
      lon: p.lon,
      dt_id: p.dt_id,
      feeder_id: p.feeder_id,
      pincode: p.pincode,
      device_id: p.device_id,
      is_energized: p.is_energized ?? true
    });
  }

  // Fetch active scheduled outages
  const outagesRes = await db.query('SELECT * FROM scheduled_outages');
  const scheduledOutages: ScheduledOutage[] = outagesRes.rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    target_id: r.target_id,
    start_time: new Date(r.start_time),
    end_time: new Date(r.end_time),
    reason: r.reason
  }));

  // Re-run localization for affected DT
  const activeFaults = localizeFaults(tree, poleStates, scheduledOutages, dtId);

  // Sync with DB faults & tickets tables
  for (const fault of activeFaults) {
    // Check if fault already exists for this span/DT
    const existingFaultRes = await db.query(
      `SELECT f.id, t.id as ticket_id, t.status 
       FROM faults f
       JOIN tickets t ON t.fault_id = f.id
       WHERE f.dt_id = $1 AND f.upstream_asset_id = $2 AND f.downstream_asset_id = $3
         AND t.status IN ('DETECTED', 'ACKNOWLEDGED', 'CREW_ASSIGNED', 'RESOLVED')`,
      [dtId, fault.upstream_asset_id, fault.downstream_asset_id]
    );

    if (existingFaultRes.rows.length === 0) {
      // Create new fault record
      const insertFaultRes = await db.query(
        `INSERT INTO faults (dt_id, feeder_id, fault_type, upstream_asset_id, downstream_asset_id, affected_pole_count, lat, lon, pincode, confidence, topology_source, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [
          fault.dt_id,
          fault.feeder_id,
          fault.fault_type,
          fault.upstream_asset_id,
          fault.downstream_asset_id,
          fault.affected_pole_count,
          fault.lat,
          fault.lon,
          fault.pincode,
          fault.confidence,
          fault.topology_source,
          fault.reason
        ]
      );
      const newFaultId = insertFaultRes.rows[0].id;

      // Generate AI/Fallback Dispatch Briefing
      const briefingRes = await generateDispatchBriefing(fault);

      // Create new ticket in DETECTED status with AI briefing
      await db.query(
        `INSERT INTO tickets (fault_id, status, ai_briefing, briefing_source) VALUES ($1, 'DETECTED', $2, $3)`,
        [newFaultId, briefingRes.briefing, briefingRes.source]
      );
    }
  }

  // If poles under an existing ticket have returned to LIVE state:
  const openTicketsRes = await db.query(
    `SELECT t.id as ticket_id, t.status, f.upstream_asset_id, f.downstream_asset_id
     FROM tickets t
     JOIN faults f ON f.id = t.fault_id
     WHERE f.dt_id = $1 AND t.status IN ('DETECTED', 'ACKNOWLEDGED', 'CREW_ASSIGNED', 'RESOLVED')`,
    [dtId]
  );

  for (const tRow of openTicketsRes.rows) {
    const isStillFaulted = activeFaults.some(
      (af) => af.upstream_asset_id === tRow.upstream_asset_id && af.downstream_asset_id === tRow.downstream_asset_id
    );

    if (!isStillFaulted) {
      // Downstream poles are energized again! Auto-verify & close ticket
      await db.query(
        `UPDATE tickets 
         SET status = 'CLOSED', verified_at = CURRENT_TIMESTAMP, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [tRow.ticket_id]
      );
    }
  }
}
