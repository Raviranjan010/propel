import { getDb } from '../db';
import { NetworkTree, PoleState, ScheduledOutage, FaultOutput } from './types';

export async function loadNetworkTreeFromDb(): Promise<NetworkTree> {
  const db = await getDb();

  const transformersRes = await db.query('SELECT * FROM transformers');
  const transformers = new Map<string, { dt_id: string; feeder_id: string; lat: number; lon: number }>();
  transformersRes.rows.forEach((t) => transformers.set(t.dt_id, t));

  const edgesRes = await db.query('SELECT * FROM topology_edges');
  const edgesByDt = new Map<string, { parent_pole_id: string; child_pole_id: string; distance_meters: number; source: 'explicit' | 'inferred'; confidence: number }[]>();
  const parentMap = new Map<string, { parent_id: string; source: 'explicit' | 'inferred'; confidence: number }>();
  const childrenMap = new Map<string, string[]>();

  for (const edge of edgesRes.rows) {
    if (!edgesByDt.has(edge.dt_id)) {
      edgesByDt.set(edge.dt_id, []);
    }
    edgesByDt.get(edge.dt_id)!.push({
      parent_pole_id: edge.parent_pole_id,
      child_pole_id: edge.child_pole_id,
      distance_meters: edge.distance_meters,
      source: edge.source,
      confidence: edge.confidence
    });

    parentMap.set(edge.child_pole_id, {
      parent_id: edge.parent_pole_id,
      source: edge.source,
      confidence: edge.confidence
    });

    if (!childrenMap.has(edge.parent_pole_id)) {
      childrenMap.set(edge.parent_pole_id, []);
    }
    childrenMap.get(edge.parent_pole_id)!.push(edge.child_pole_id);
  }

  return { transformers, edgesByDt, parentMap, childrenMap };
}

export function localizeFaults(
  tree: NetworkTree,
  poleStates: Map<string, PoleState>,
  scheduledOutages: ScheduledOutage[] = [],
  filterDtId?: string,
  now: Date = new Date()
): FaultOutput[] {
  const faults: FaultOutput[] = [];

  // 1. Identify active scheduled outages
  const activeScheduledFeeders = new Set<string>();
  const activeScheduledDts = new Set<string>();

  for (const outage of scheduledOutages) {
    if (outage.start_time <= now && outage.end_time >= now) {
      if (outage.scope === 'feeder') {
        activeScheduledFeeders.add(outage.target_id);
      } else if (outage.scope === 'dt') {
        activeScheduledDts.add(outage.target_id);
      }
    }
  }

  const allPoles = Array.from(poleStates.values());
  const polesByFeeder = new Map<string, PoleState[]>();
  const polesByDt = new Map<string, PoleState[]>();

  allPoles.forEach((p) => {
    if (!polesByFeeder.has(p.feeder_id)) polesByFeeder.set(p.feeder_id, []);
    polesByFeeder.get(p.feeder_id)!.push(p);

    if (!polesByDt.has(p.dt_id)) polesByDt.set(p.dt_id, []);
    polesByDt.get(p.dt_id)!.push(p);
  });

  // Step A: Feeder-level Outage Detection
  const affectedFeeders = new Set<string>();
  if (!filterDtId) {
    for (const [feederId, poles] of polesByFeeder.entries()) {
      if (activeScheduledFeeders.has(feederId)) continue;
      if (poles.length > 0 && poles.every((p) => !p.is_energized)) {
        affectedFeeders.add(feederId);
        const dt0 = tree.transformers.get(poles[0].dt_id);
        faults.push({
          fault_type: 'FEEDER',
          dt_id: poles[0].dt_id,
          feeder_id: feederId,
          upstream_asset_id: feederId,
          downstream_asset_id: feederId,
          lat: dt0 ? dt0.lat : poles[0].lat,
          lon: dt0 ? dt0.lon : poles[0].lon,
          pincode: poles[0].pincode,
          affected_pole_count: poles.length,
          confidence: 1.0,
          topology_source: 'explicit',
          reason: `Feeder ${feederId} blackout detected: all ${poles.length} downstream poles are dark`
        });
      }
    }
  }

  // Step B: DT-level Outage Detection
  const affectedDts = new Set<string>();
  for (const [dtId, poles] of polesByDt.entries()) {
    if (filterDtId && dtId !== filterDtId) continue;
    if (activeScheduledFeeders.has(poles[0].feeder_id) || activeScheduledDts.has(dtId)) continue;
    if (affectedFeeders.has(poles[0].feeder_id)) continue; // Covered by feeder fault

    if (poles.length > 0 && poles.every((p) => !p.is_energized)) {
      affectedDts.add(dtId);
      const dtInfo = tree.transformers.get(dtId);
      const source = tree.edgesByDt.get(dtId)?.[0]?.source || 'explicit';
      faults.push({
        fault_type: 'DT',
        dt_id: dtId,
        feeder_id: poles[0].feeder_id,
        upstream_asset_id: dtId,
        downstream_asset_id: dtId,
        lat: dtInfo ? dtInfo.lat : poles[0].lat,
        lon: dtInfo ? dtInfo.lon : poles[0].lon,
        pincode: poles[0].pincode,
        affected_pole_count: poles.length,
        confidence: 1.0,
        topology_source: source,
        reason: `Distribution Transformer ${dtId} outage detected: all ${poles.length} poles under DT are dark`
      });
    }
  }

  // Helper to check if a pole subtree has any energized poles
  const hasEnergizedDescendants = (nodeId: string): boolean => {
    const children = tree.childrenMap.get(nodeId) || [];
    for (const childId of children) {
      const pState = poleStates.get(childId);
      if (pState && pState.is_energized) return true;
      if (hasEnergizedDescendants(childId)) return true;
    }
    return false;
  };

  // Step C: Dead Sensor Identification & Span Boundary Discovery
  const deadSensors = new Set<string>();
  for (const [poleId, pole] of poleStates.entries()) {
    if (!pole.is_energized) {
      if (hasEnergizedDescendants(poleId)) {
        deadSensors.add(poleId); // Dark pole with live children = sensor/lamp failure
      }
    }
  }

  // Node effective state: LIVE if energized or dead sensor, DARK if un-energized and not a dead sensor
  const isNodeLive = (nodeId: string): boolean => {
    if (nodeId.startsWith('D-') || nodeId.startsWith('F-')) return true; // Transformer/feeder upstream is live
    const pState = poleStates.get(nodeId);
    if (!pState) return true;
    return pState.is_energized || deadSensors.has(nodeId);
  };

  // Step D: Live/Dark Boundary Frontier Discovery
  const dtsToProcess = filterDtId ? [filterDtId] : Array.from(polesByDt.keys());

  for (const dtId of dtsToProcess) {
    if (affectedFeeders.has(polesByDt.get(dtId)?.[0]?.feeder_id || '')) continue;
    if (affectedDts.has(dtId)) continue;
    if (activeScheduledDts.has(dtId) || activeScheduledFeeders.has(polesByDt.get(dtId)?.[0]?.feeder_id || '')) continue;

    const dtInfo = tree.transformers.get(dtId);
    const dtPoles = polesByDt.get(dtId) || [];
    const dtPolesMap = new Map<string, PoleState>();
    dtPoles.forEach((p) => dtPolesMap.set(p.pole_id, p));

    // Find boundary edges: (parent, child) where parent is LIVE and child is DARK
    for (const pole of dtPoles) {
      if (!isNodeLive(pole.pole_id)) {
        const parentInfo = tree.parentMap.get(pole.pole_id);
        const parentId = parentInfo ? parentInfo.parent_id : dtId;

        if (isNodeLive(parentId)) {
          // Found live/dark boundary root!
          let parentLat = dtInfo ? dtInfo.lat : pole.lat;
          let parentLon = dtInfo ? dtInfo.lon : pole.lon;

          if (parentId.startsWith('P-')) {
            const parentPole = poleStates.get(parentId);
            if (parentPole) {
              parentLat = parentPole.lat;
              parentLon = parentPole.lon;
            }
          }

          const midLat = Math.round(((parentLat + pole.lat) / 2) * 1000000) / 1000000;
          const midLon = Math.round(((parentLon + pole.lon) / 2) * 1000000) / 1000000;

          // Count all downstream poles under this dark root
          const getSubtreePoles = (rootId: string): string[] => {
            const result = [rootId];
            const children = tree.childrenMap.get(rootId) || [];
            children.forEach((c) => result.push(...getSubtreePoles(c)));
            return result;
          };

          const affectedPoles = getSubtreePoles(pole.pole_id);
          const pincode = pole.pincode || dtPoles.find((p) => p.pincode)?.pincode || '560078';
          const source = parentInfo?.source || 'explicit';
          const confidence = parentInfo?.confidence ?? 1.0;

          const reason = source === 'explicit'
            ? `Span fault detected on line segment between ${parentId} and ${pole.pole_id} affecting ${affectedPoles.length} poles`
            : `Inferred span corridor fault between ${parentId} and ${pole.pole_id} affecting ${affectedPoles.length} poles (confidence: ${(confidence * 100).toFixed(0)}%)`;

          faults.push({
            fault_type: 'SPAN',
            dt_id: dtId,
            feeder_id: pole.feeder_id,
            upstream_asset_id: parentId,
            downstream_asset_id: pole.pole_id,
            lat: midLat,
            lon: midLon,
            pincode,
            affected_pole_count: affectedPoles.length,
            confidence,
            topology_source: source,
            reason
          });
        }
      }
    }
  }

  return faults;
}
