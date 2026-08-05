import { getDb } from '../db';

export interface Pole {
  pole_id: string;
  lat: number;
  lon: number;
  feeder_id: string;
  dt_id: string;
  seq_on_line: number | null;
  parent_pole_id: string | null;
  pincode: string | null;
  device_id: string | null;
  is_energized: boolean;
}

export interface Transformer {
  dt_id: string;
  feeder_id: string;
  lat: number;
  lon: number;
}

export interface TopologyEdge {
  dt_id: string;
  parent_pole_id: string; // DT id or pole_id
  child_pole_id: string;
  distance_meters: number;
  source: 'explicit' | 'inferred';
  confidence: number;
}

// Calculate Haversine distance in meters between two lat/lon coordinates
export function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function buildTopologyForDt(dtId: string): Promise<TopologyEdge[]> {
  const db = await getDb();

  // Fetch DT details
  const dtRes = await db.query('SELECT * FROM transformers WHERE dt_id = $1', [dtId]);
  if (dtRes.rows.length === 0) {
    throw new Error(`DT not found: ${dtId}`);
  }
  const dt: Transformer = dtRes.rows[0];

  // Fetch all poles under this DT
  const polesRes = await db.query('SELECT * FROM poles WHERE dt_id = $1', [dtId]);
  const poles: Pole[] = polesRes.rows;

  if (poles.length === 0) return [];

  // Determine if explicit topology exists (if at least one pole has parent_pole_id / seq_on_line)
  const isExplicit = poles.some((p) => p.parent_pole_id !== null || p.seq_on_line !== null);
  const edges: TopologyEdge[] = [];

  if (isExplicit) {
    // 1. Explicit tree from parent_pole_id where present
    const poleMap = new Map<string, Pole>();
    poles.forEach((p) => poleMap.set(p.pole_id, p));

    for (const p of poles) {
      let parentId = p.parent_pole_id;
      let parentLat = dt.lat;
      let parentLon = dt.lon;

      if (!parentId || parentId === dt.dt_id || p.seq_on_line === 1) {
        parentId = dt.dt_id;
      } else {
        const parentPole = poleMap.get(parentId);
        if (parentPole) {
          parentLat = parentPole.lat;
          parentLon = parentPole.lon;
        }
      }

      const dist = haversineDistanceMeters(parentLat, parentLon, p.lat, p.lon);
      edges.push({
        dt_id: dtId,
        parent_pole_id: parentId,
        child_pole_id: p.pole_id,
        distance_meters: Math.round(dist * 10) / 10,
        source: 'explicit',
        confidence: 1.0
      });
    }
  } else {
    // 2. Geometric nearest-neighbor inference outward from DT
    const connectedNodes = new Map<string, { lat: number; lon: number }>();
    connectedNodes.set(dt.dt_id, { lat: dt.lat, lon: dt.lon });

    const unconnectedPoles = new Map<string, Pole>();
    poles.forEach((p) => unconnectedPoles.set(p.pole_id, p));

    while (unconnectedPoles.size > 0) {
      let bestDist = Infinity;
      let bestParentId = '';
      let bestChildPoleId = '';
      let bestChildPole: Pole | null = null;

      // Find shortest geometric edge from any connected node to any unconnected pole
      for (const [connId, connCoords] of connectedNodes.entries()) {
        for (const [poleId, pole] of unconnectedPoles.entries()) {
          const d = haversineDistanceMeters(connCoords.lat, connCoords.lon, pole.lat, pole.lon);
          if (d < bestDist) {
            bestDist = d;
            bestParentId = connId;
            bestChildPoleId = poleId;
            bestChildPole = pole;
          }
        }
      }

      if (!bestChildPole) break;

      // Calculate confidence based on proximity (decay with longer distances)
      const confidence = Math.max(0.40, Math.min(0.90, Math.round((1.0 - (bestDist / 250.0)) * 100) / 100));

      edges.push({
        dt_id: dtId,
        parent_pole_id: bestParentId,
        child_pole_id: bestChildPoleId,
        distance_meters: Math.round(bestDist * 10) / 10,
        source: 'inferred',
        confidence
      });

      connectedNodes.set(bestChildPoleId, { lat: bestChildPole.lat, lon: bestChildPole.lon });
      unconnectedPoles.delete(bestChildPoleId);
    }
  }

  // Persist edges in topology_edges table
  await db.query('DELETE FROM topology_edges WHERE dt_id = $1', [dtId]);
  for (const edge of edges) {
    await db.query(
      `INSERT INTO topology_edges (dt_id, parent_pole_id, child_pole_id, distance_meters, source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [edge.dt_id, edge.parent_pole_id, edge.child_pole_id, edge.distance_meters, edge.source, edge.confidence]
    );
  }

  return edges;
}

export async function buildAllTopologies(): Promise<{ explicitCount: number; inferredCount: number; totalEdges: number }> {
  const db = await getDb();
  const dtsRes = await db.query('SELECT dt_id FROM transformers');
  let explicitCount = 0;
  let inferredCount = 0;
  let totalEdges = 0;

  for (const row of dtsRes.rows) {
    const edges = await buildTopologyForDt(row.dt_id);
    totalEdges += edges.length;
    if (edges.length > 0) {
      if (edges[0].source === 'explicit') explicitCount++;
      else inferredCount++;
    }
  }

  return { explicitCount, inferredCount, totalEdges };
}

if (require.main === module) {
  buildAllTopologies()
    .then((res) => {
      console.log('Successfully built network topology tree edges:');
      console.log(`- Mapped DTs with EXPLICIT tree topology: ${res.explicitCount}`);
      console.log(`- Unmapped DTs with INFERRED geometric nearest-neighbor topology: ${res.inferredCount}`);
      console.log(`- Total Topology Edges Constructed: ${res.totalEdges}`);
    })
    .catch((err) => {
      console.error('Failed to build topology:', err);
      process.exit(1);
    });
}
