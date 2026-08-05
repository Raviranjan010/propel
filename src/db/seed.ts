import { getDb, initDbSchema } from './index';

export interface SeedStats {
  totalTransformers: number;
  totalPoles: number;
  unmappedDtsCount: number;
  unmappedDtRatio: number;
  noDevicePolesCount: number;
  noDeviceRatio: number;
  missingPincodeCount: number;
  missingPincodeRatio: number;
}

export async function generateAndSeedData(): Promise<SeedStats> {
  await initDbSchema();
  const db = await getDb();

  // Clear existing records
  await db.query('DELETE FROM tickets;');
  await db.query('DELETE FROM faults;');
  await db.query('DELETE FROM topology_edges;');
  await db.query('DELETE FROM telemetry_events;');
  await db.query('DELETE FROM scheduled_outages;');
  await db.query('DELETE FROM poles;');
  await db.query('DELETE FROM transformers;');

  const totalDts = 30;
  const polesPerDt = 100; // 30 * 100 = 3000 poles total
  const feeders = ['F-01-01', 'F-01-02', 'F-02-01', 'F-02-02'];

  // 60% of DTs missing seq_on_line/parent_pole_id => 18 unmapped DTs, 12 mapped DTs
  const unmappedDtIndices = new Set<number>();
  const unmappedCount = Math.round(totalDts * 0.60); // 18
  for (let i = 0; i < unmappedCount; i++) {
    unmappedDtIndices.add(i); // First 18 DTs are unmapped
  }

  let poleCounter = 1;
  let deviceCounter = 1;
  let noDeviceCount = 0;
  let missingPincodeCount = 0;

  const baseLat = 12.9716;
  const baseLon = 77.5946;

  for (let dtIdx = 0; dtIdx < totalDts; dtIdx++) {
    const dtId = `D-${String(dtIdx + 1).padStart(4, '0')}`;
    const feederId = feeders[dtIdx % feeders.length];
    const isUnmapped = unmappedDtIndices.has(dtIdx);

    const dtLat = baseLat + (Math.floor(dtIdx / 6) * 0.015) + ((dtIdx % 6) * 0.002);
    const dtLon = baseLon + ((dtIdx % 6) * 0.015) + ((dtIdx % 3) * 0.002);

    await db.query(
      `INSERT INTO transformers (dt_id, feeder_id, lat, lon, capacity_kva, households_served)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [dtId, feederId, dtLat, dtLon, 250, 120]
    );

    // Build synthetic radial tree structure for poles under this DT
    // Main trunk: 60 poles. Spur 1: 20 poles off pole 20. Spur 2: 20 poles off pole 40.
    const poleTree: { poleId: string; parentId: string | null; seq: number; lat: number; lon: number }[] = [];

    // Main trunk
    let prevPoleId: string | null = null;
    let currLat = dtLat;
    let currLon = dtLon;

    for (let i = 1; i <= 60; i++) {
      const poleId = `P-${String(poleCounter++).padStart(6, '0')}`;
      currLat += 0.0003 + (Math.sin(i) * 0.00005);
      currLon += 0.0002 + (Math.cos(i) * 0.00005);
      poleTree.push({ poleId, parentId: prevPoleId, seq: i, lat: currLat, lon: currLon });
      prevPoleId = poleId;
    }

    // Spur 1 off main trunk pole 20 (index 19)
    const spur1Parent = poleTree[19].poleId;
    let spur1Prev = spur1Parent;
    let spur1Lat = poleTree[19].lat;
    let spur1Lon = poleTree[19].lon;
    for (let i = 1; i <= 20; i++) {
      const poleId = `P-${String(poleCounter++).padStart(6, '0')}`;
      spur1Lat -= 0.0002;
      spur1Lon += 0.0003;
      poleTree.push({ poleId, parentId: spur1Prev, seq: 60 + i, lat: spur1Lat, lon: spur1Lon });
      spur1Prev = poleId;
    }

    // Spur 2 off main trunk pole 40 (index 39)
    const spur2Parent = poleTree[39].poleId;
    let spur2Prev = spur2Parent;
    let spur2Lat = poleTree[39].lat;
    let spur2Lon = poleTree[39].lon;
    for (let i = 1; i <= 20; i++) {
      const poleId = `P-${String(poleCounter++).padStart(6, '0')}`;
      spur2Lat += 0.0003;
      spur2Lon -= 0.0002;
      poleTree.push({ poleId, parentId: spur2Prev, seq: 80 + i, lat: spur2Lat, lon: spur2Lon });
      spur2Prev = poleId;
    }

    // Now insert poles into DB matching proportions:
    // 9% no device, 3% missing pincode, 60% missing seq_on_line & parent_pole_id
    for (let pIdx = 0; pIdx < poleTree.length; pIdx++) {
      const node = poleTree[pIdx];

      // 9% no device
      const hasDevice = (poleCounter + pIdx) % 100 >= 9; // ~91% fitted, 9% missing
      let deviceId: string | null = null;
      if (hasDevice) {
        deviceId = `KSPDB-DEV-${String(deviceCounter++).padStart(6, '0')}`;
      } else {
        noDeviceCount++;
      }

      // 3% missing pincode
      const hasPincode = (poleCounter + pIdx) % 100 >= 3;
      let pincode: string | null = null;
      if (hasPincode) {
        pincode = '560078';
      } else {
        missingPincodeCount++;
      }

      const seqOnLine = isUnmapped ? null : node.seq;
      const parentPoleId = isUnmapped ? null : node.parentId;

      await db.query(
        `INSERT INTO poles (pole_id, lat, lon, feeder_id, dt_id, seq_on_line, parent_pole_id, pole_type, ward, pincode, device_id, is_energized)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          node.poleId,
          node.lat,
          node.lon,
          feederId,
          dtId,
          seqOnLine,
          parentPoleId,
          'LT-9m-PCC',
          'W-084',
          pincode,
          deviceId,
          true
        ]
      );
    }
  }

  const totalPoles = totalDts * polesPerDt;
  return {
    totalTransformers: totalDts,
    totalPoles,
    unmappedDtsCount: unmappedCount,
    unmappedDtRatio: unmappedCount / totalDts,
    noDevicePolesCount: noDeviceCount,
    noDeviceRatio: noDeviceCount / totalPoles,
    missingPincodeCount,
    missingPincodeRatio: missingPincodeCount / totalPoles
  };
}

if (require.main === module) {
  generateAndSeedData()
    .then((stats) => {
      console.log('Successfully seeded synthetic grid network dataset:');
      console.log(`- Total Transformers (DTs): ${stats.totalTransformers}`);
      console.log(`- Total Poles: ${stats.totalPoles}`);
      console.log(`- Unmapped DTs (missing seq_on_line/parent_pole_id): ${stats.unmappedDtsCount} (${(stats.unmappedDtRatio * 100).toFixed(1)}%)`);
      console.log(`- Poles with no IoT device: ${stats.noDevicePolesCount} (${(stats.noDeviceRatio * 100).toFixed(1)}%)`);
      console.log(`- Poles missing pincode: ${stats.missingPincodeCount} (${(stats.missingPincodeRatio * 100).toFixed(1)}%)`);
    })
    .catch((err) => {
      console.error('Failed to seed dataset:', err);
      process.exit(1);
    });
}
