import express, { Request, Response } from 'express';
import path from 'path';
import { getDb, initDbSchema } from './db';
import { processTelemetryEvent, syncFaultsAndTicketsForDt, TelemetryPayload } from './services/telemetryIngest';
import { loadNetworkTreeFromDb, localizeFaults } from './services/localization';
import { generateDispatchBriefing } from './services/aiCopilot';

export const app = express();
app.use(express.json());

// Serve static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// Health check
app.get('/health', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const countRes = await db.query('SELECT COUNT(*) as count FROM poles');
    res.json({
      status: 'healthy',
      database: 'connected',
      poles_loaded: parseInt(countRes.rows[0]?.count || '0', 10)
    });
  } catch (err: any) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 1. Ingest Endpoint (Item 5)
app.post('/api/telemetry', async (req: Request, res: Response) => {
  try {
    const payload: TelemetryPayload = req.body;
    if (!payload.device_id || !payload.pole_id || payload.energized === undefined || payload.seq === undefined) {
      return res.status(400).json({ error: 'Missing required telemetry fields' });
    }

    const result = await processTelemetryEvent(payload);
    return res.status(202).json({
      status: result.status,
      reLocalized: result.reLocalized,
      affectedDtId: result.affectedDtId
    });
  } catch (err: any) {
    console.error('Ingest error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2. Ticket Management Endpoints (Item 6)
app.get('/api/tickets', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const result = await db.query(`
      SELECT 
        t.id as ticket_id,
        t.status,
        t.assigned_crew,
        t.ai_briefing,
        t.briefing_source,
        t.detected_at,
        t.updated_at,
        t.verified_at,
        t.closed_at,
        f.id as fault_id,
        f.dt_id,
        f.feeder_id,
        f.fault_type,
        f.upstream_asset_id,
        f.downstream_asset_id,
        f.affected_pole_count,
        f.lat,
        f.lon,
        f.pincode,
        f.confidence,
        f.topology_source,
        f.reason
      FROM tickets t
      JOIN faults f ON f.id = t.fault_id
      ORDER BY t.id DESC
    `);
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/briefing', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;
    const ticketRes = await db.query(
      `SELECT t.id, f.* FROM tickets t JOIN faults f ON f.id = t.fault_id WHERE t.id = $1`,
      [ticketId]
    );

    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const fault = ticketRes.rows[0];
    const briefingRes = await generateDispatchBriefing({
      upstream_asset_id: fault.upstream_asset_id,
      downstream_asset_id: fault.downstream_asset_id,
      dt_id: fault.dt_id,
      feeder_id: fault.feeder_id,
      affected_pole_count: fault.affected_pole_count,
      pincode: fault.pincode,
      confidence: fault.confidence,
      topology_source: fault.topology_source,
      reason: fault.reason,
      lat: fault.lat,
      lon: fault.lon
    });

    await db.query(
      `UPDATE tickets SET ai_briefing = $1, briefing_source = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [briefingRes.briefing, briefingRes.source, ticketId]
    );

    res.json({
      success: true,
      ticket_id: ticketId,
      ai_briefing: briefingRes.briefing,
      briefing_source: briefingRes.source
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/acknowledge', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;
    await db.query(`UPDATE tickets SET status = 'ACKNOWLEDGED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [ticketId]);
    res.json({ success: true, ticket_id: ticketId, status: 'ACKNOWLEDGED' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/assign-crew', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;
    const { crew } = req.body;
    await db.query(
      `UPDATE tickets SET status = 'CREW_ASSIGNED', assigned_crew = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [crew || 'Crew Alpha', ticketId]
    );
    res.json({ success: true, ticket_id: ticketId, status: 'CREW_ASSIGNED', crew });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/tickets/:id/resolve', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;
    await db.query(`UPDATE tickets SET status = 'RESOLVED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [ticketId]);
    res.json({ success: true, ticket_id: ticketId, status: 'RESOLVED' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Item 6 Rule: VERIFIED / CLOSED CANNOT be set manually unless telemetry confirms poles are live!
app.post('/api/tickets/:id/verify', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const ticketId = req.params.id;

    // Check if downstream poles under this ticket's fault are energized
    const ticketRes = await db.query(
      `SELECT t.id, f.dt_id, f.upstream_asset_id, f.downstream_asset_id
       FROM tickets t
       JOIN faults f ON f.id = t.fault_id
       WHERE t.id = $1`,
      [ticketId]
    );

    if (ticketRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' });
    }

    const { dt_id, downstream_asset_id } = ticketRes.rows[0];

    // Check downstream pole state
    const poleRes = await db.query('SELECT is_energized FROM poles WHERE pole_id = $1', [downstream_asset_id]);
    const isEnergized = poleRes.rows[0]?.is_energized ?? false;

    if (!isEnergized) {
      return res.status(400).json({
        error: 'TELEMETRY_VERIFICATION_FAILED',
        message: 'Ticket closure rejected: field telemetry confirms downstream poles are still DARK. Ticket remains unverified.'
      });
    }

    await db.query(
      `UPDATE tickets SET status = 'CLOSED', verified_at = CURRENT_TIMESTAMP, closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [ticketId]
    );

    res.json({ success: true, ticket_id: ticketId, status: 'CLOSED', verifiedByTelemetry: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Fault Simulator Endpoints (Item 7)
app.post('/api/simulator/inject-fault', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { fault_type, target_id } = req.body; // fault_type: 'SPAN' | 'DT' | 'FEEDER'

    let affectedDtId = '';

    if (fault_type === 'SPAN') {
      // target_id is root pole_id
      const targetPoleRes = await db.query('SELECT dt_id FROM poles WHERE pole_id = $1', [target_id]);
      if (targetPoleRes.rows.length === 0) return res.status(400).json({ error: `Pole not found: ${target_id}` });
      affectedDtId = targetPoleRes.rows[0].dt_id;

      // Mark pole + all downstream poles dark
      const tree = await loadNetworkTreeFromDb();
      const getSubtree = (nodeId: string): string[] => {
        const list = [nodeId];
        const children = tree.childrenMap.get(nodeId) || [];
        children.forEach((c) => list.push(...getSubtree(c)));
        return list;
      };

      const darkPoles = getSubtree(target_id);
      for (const pId of darkPoles) {
        await db.query('UPDATE poles SET is_energized = FALSE WHERE pole_id = $1', [pId]);
      }
    } else if (fault_type === 'DT') {
      affectedDtId = target_id;
      await db.query('UPDATE poles SET is_energized = FALSE WHERE dt_id = $1', [target_id]);
    } else if (fault_type === 'FEEDER') {
      await db.query('UPDATE poles SET is_energized = FALSE WHERE feeder_id = $1', [target_id]);
      const dtRes = await db.query('SELECT dt_id FROM transformers WHERE feeder_id = $1 LIMIT 1', [target_id]);
      affectedDtId = dtRes.rows[0]?.dt_id || 'D-0001';
    }

    await syncFaultsAndTicketsForDt(affectedDtId);
    res.json({ success: true, injected: fault_type, target_id, affectedDtId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/simulator/repair-fault', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { fault_type, target_id } = req.body;

    let affectedDtId = '';

    if (fault_type === 'SPAN') {
      const targetPoleRes = await db.query('SELECT dt_id FROM poles WHERE pole_id = $1', [target_id]);
      if (targetPoleRes.rows.length === 0) return res.status(400).json({ error: `Pole not found: ${target_id}` });
      affectedDtId = targetPoleRes.rows[0].dt_id;

      const tree = await loadNetworkTreeFromDb();
      const getSubtree = (nodeId: string): string[] => {
        const list = [nodeId];
        const children = tree.childrenMap.get(nodeId) || [];
        children.forEach((c) => list.push(...getSubtree(c)));
        return list;
      };

      const restoredPoles = getSubtree(target_id);
      for (const pId of restoredPoles) {
        await db.query('UPDATE poles SET is_energized = TRUE WHERE pole_id = $1', [pId]);
      }
    } else if (fault_type === 'DT') {
      affectedDtId = target_id;
      await db.query('UPDATE poles SET is_energized = TRUE WHERE dt_id = $1', [target_id]);
    } else if (fault_type === 'FEEDER') {
      await db.query('UPDATE poles SET is_energized = TRUE WHERE feeder_id = $1', [target_id]);
      const dtRes = await db.query('SELECT dt_id FROM transformers WHERE feeder_id = $1 LIMIT 1', [target_id]);
      affectedDtId = dtRes.rows[0]?.dt_id || 'D-0001';
    }

    await syncFaultsAndTicketsForDt(affectedDtId);
    res.json({ success: true, repaired: fault_type, target_id, affectedDtId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Map View Raw Data Endpoint
app.get('/api/map/poles', async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const poles = await db.query('SELECT pole_id, lat, lon, dt_id, feeder_id, is_energized, device_id, pincode FROM poles');
    const edges = await db.query('SELECT dt_id, parent_pole_id, child_pole_id, source, confidence FROM topology_edges');
    const dts = await db.query('SELECT dt_id, feeder_id, lat, lon FROM transformers');
    res.json({ poles: poles.rows, edges: edges.rows, dts: dts.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8000;

export function startServer() {
  return app.listen(PORT, () => {
    console.log(`KSPDB Ingestion API & SCADA Server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startServer();
}
