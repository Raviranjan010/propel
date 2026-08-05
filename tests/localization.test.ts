import { describe, it, expect, beforeAll } from 'vitest';
import { generateAndSeedData } from '../src/db/seed';
import { buildAllTopologies } from '../src/services/topologyBuilder';
import { getDb } from '../src/db';
import { NetworkTree, PoleState, ScheduledOutage } from '../src/services/types';
import { loadNetworkTreeFromDb, localizeFaults } from '../src/services/localization';

describe('Pure Fault Localization Engine Unit Tests', () => {
  let tree: NetworkTree;
  let poleStates: Map<string, PoleState>;

  beforeAll(async () => {
    // Seed and build topologies for 3,000 poles
    await generateAndSeedData();
    await buildAllTopologies();

    tree = await loadNetworkTreeFromDb();
    const db = await getDb();
    const polesRes = await db.query('SELECT * FROM poles');
    poleStates = new Map<string, PoleState>();
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
  }, 30000);

  it('1. Returns empty fault array when all poles are energized', () => {
    const faults = localizeFaults(tree, poleStates, []);
    expect(faults).toHaveLength(0);
  });

  it('2. Detects mid-line span fault at live/dark boundary', () => {
    // Pick mapped DT D-0019 (index 18)
    const dtPoles = Array.from(poleStates.values()).filter((p) => p.dt_id === 'D-0019');
    expect(dtPoles.length).toBeGreaterThan(10);

    // Set poles downstream of pole 10 to dark
    const testStates = new Map(poleStates);
    const targetParent = dtPoles[5].pole_id; // Live
    const targetChild = dtPoles[6].pole_id; // Dark

    // Set child and all its downstream children to dark
    const setDark = (nodeId: string) => {
      const p = testStates.get(nodeId);
      if (p) testStates.set(nodeId, { ...p, is_energized: false });
      const children = tree.childrenMap.get(nodeId) || [];
      children.forEach(setDark);
    };
    setDark(targetChild);

    const faults = localizeFaults(tree, testStates, [], 'D-0019');
    expect(faults).toHaveLength(1);
    expect(faults[0].fault_type).toBe('SPAN');
    expect(faults[0].dt_id).toBe('D-0019');
    expect(faults[0].downstream_asset_id).toBe(targetChild);
    expect(faults[0].affected_pole_count).toBeGreaterThanOrEqual(1);
  });

  it('3. Detects DT-level blackout when all poles under a DT go dark', () => {
    const testStates = new Map(poleStates);
    for (const [id, pole] of testStates.entries()) {
      if (pole.dt_id === 'D-0001') {
        testStates.set(id, { ...pole, is_energized: false });
      }
    }

    const faults = localizeFaults(tree, testStates, [], 'D-0001');
    expect(faults).toHaveLength(1);
    expect(faults[0].fault_type).toBe('DT');
    expect(faults[0].dt_id).toBe('D-0001');
    expect(faults[0].affected_pole_count).toBe(100);
  });

  it('4. Detects Feeder-level blackout when all DTs under a feeder go dark', () => {
    const testStates = new Map(poleStates);
    const targetFeeder = 'F-01-01';
    for (const [id, pole] of testStates.entries()) {
      if (pole.feeder_id === targetFeeder) {
        testStates.set(id, { ...pole, is_energized: false });
      }
    }

    const faults = localizeFaults(tree, testStates, []);
    const feederFaults = faults.filter((f) => f.fault_type === 'FEEDER' && f.feeder_id === targetFeeder);
    expect(feederFaults).toHaveLength(1);
  });

  it('5. Excludes dead-sensor cases (dark pole with live children downstream)', () => {
    const testStates = new Map(poleStates);
    // Find a pole that has children
    let poleWithChildren: string | null = null;
    for (const [poleId, children] of tree.childrenMap.entries()) {
      if (poleId.startsWith('P-') && children.length > 0) {
        poleWithChildren = poleId;
        break;
      }
    }

    expect(poleWithChildren).not.toBeNull();
    const targetPole = testStates.get(poleWithChildren!)!;
    // Set target pole dark, but keep all children live
    testStates.set(poleWithChildren!, { ...targetPole, is_energized: false });

    const faults = localizeFaults(tree, testStates, [], targetPole.dt_id);
    expect(faults).toHaveLength(0); // Should be excluded as dead sensor!
  });

  it('6. Suppresses alerts during scheduled load shedding', () => {
    const testStates = new Map(poleStates);
    for (const [id, pole] of testStates.entries()) {
      if (pole.dt_id === 'D-0005') {
        testStates.set(id, { ...pole, is_energized: false });
      }
    }

    const scheduledOutages: ScheduledOutage[] = [
      {
        id: 'SO-001',
        scope: 'dt',
        target_id: 'D-0005',
        start_time: new Date(Date.now() - 3600000),
        end_time: new Date(Date.now() + 3600000),
        reason: 'Scheduled DT maintenance'
      }
    ];

    const faults = localizeFaults(tree, testStates, scheduledOutages, 'D-0005');
    expect(faults).toHaveLength(0); // Suppressed by scheduled outage!
  });

  it('7. Handles multiple simultaneous faults on separate branches without incorrect merging', () => {
    const dtId = 'D-0020';
    const testStates = new Map(poleStates);
    const dtPoles = Array.from(poleStates.values()).filter((p) => p.dt_id === dtId);

    // Pick two separate branch children under D-0020
    const topLevelChildren = tree.childrenMap.get(dtId) || [];
    expect(topLevelChildren.length).toBeGreaterThanOrEqual(1);

    // Dark branch 1
    const setDark = (nodeId: string) => {
      const p = testStates.get(nodeId);
      if (p) testStates.set(nodeId, { ...p, is_energized: false });
      const children = tree.childrenMap.get(nodeId) || [];
      children.forEach(setDark);
    };

    // Dark two distinct independent spur subtrees: spur 1 (index 60) and spur 2 (index 80)
    const spur1Root = dtPoles[60].pole_id;
    const spur2Root = dtPoles[80].pole_id;

    setDark(spur1Root);
    setDark(spur2Root);

    const faults = localizeFaults(tree, testStates, [], dtId);
    expect(faults.length).toBeGreaterThanOrEqual(2); // Must detect multiple faults distinctly!
  });

  it('8. Correctly tags explicit vs inferred topology source and confidence', () => {
    const testStates = new Map(poleStates);

    // Mapped DT (D-0019, index 18)
    const mappedPoles = Array.from(poleStates.values()).filter((p) => p.dt_id === 'D-0019');
    const setDark = (nodeId: string) => {
      const p = testStates.get(nodeId);
      if (p) testStates.set(nodeId, { ...p, is_energized: false });
      const children = tree.childrenMap.get(nodeId) || [];
      children.forEach(setDark);
    };
    setDark(mappedPoles[0].pole_id);

    const mappedFaults = localizeFaults(tree, testStates, [], 'D-0019');
    expect(mappedFaults.length).toBeGreaterThan(0);
    expect(mappedFaults[0].topology_source).toBe('explicit');
    expect(mappedFaults[0].confidence).toBe(1.0);

    // Unmapped DT (D-0001, index 0)
    const unmappedPoles = Array.from(poleStates.values()).filter((p) => p.dt_id === 'D-0001');
    setDark(unmappedPoles[5].pole_id);

    const unmappedFaults = localizeFaults(tree, testStates, [], 'D-0001');
    expect(unmappedFaults.length).toBeGreaterThan(0);
    expect(unmappedFaults[0].topology_source).toBe('inferred');
    expect(unmappedFaults[0].confidence).toBeLessThan(1.0);
  });
});
