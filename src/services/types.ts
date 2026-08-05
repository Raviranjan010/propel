export interface PoleState {
  pole_id: string;
  lat: number;
  lon: number;
  dt_id: string;
  feeder_id: string;
  pincode: string | null;
  device_id: string | null;
  is_energized: boolean;
}

export interface NetworkTree {
  transformers: Map<string, { dt_id: string; feeder_id: string; lat: number; lon: number }>;
  edgesByDt: Map<string, { parent_pole_id: string; child_pole_id: string; distance_meters: number; source: 'explicit' | 'inferred'; confidence: number }[]>;
  parentMap: Map<string, { parent_id: string; source: 'explicit' | 'inferred'; confidence: number }>;
  childrenMap: Map<string, string[]>; // node_id -> array of child_pole_ids
}

export interface ScheduledOutage {
  id: string;
  scope: 'feeder' | 'dt';
  target_id: string;
  start_time: Date;
  end_time: Date;
  reason?: string;
}

export interface FaultOutput {
  fault_type: 'SPAN' | 'DT' | 'FEEDER';
  dt_id: string;
  feeder_id: string;
  upstream_asset_id: string;
  downstream_asset_id: string;
  lat: number;
  lon: number;
  pincode: string | null;
  affected_pole_count: number;
  confidence: number;
  topology_source: 'explicit' | 'inferred';
  reason: string;
}
