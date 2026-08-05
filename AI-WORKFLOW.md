# KSPDB Automated Fault Localization System — AI Workflow & Engineering Log

This document details the AI-augmented development workflow, tool selection, delegation decisions, critical AI failure modes encountered, and prompt engineering strategies used to build this system.

---

## 1. AI Tooling Stack & Delegation Strategy

| Tool | Primary Purpose | Scope of Work |
| :--- | :--- | :--- |
| **Claude 3.5 Sonnet / Opus** | Architecture RFCs, Graph Algorithms & Ingestion Pipeline | Authoring RFCs, writing the boundary frontier algorithm, PostGIS queries, and edge-case handling. |
| **Cursor AI / Antigravity Agent** | Code Generation & Full-Stack Component Building | Boilerplate, React Mapbox UI components, FastAPI endpoints, and Docker compose environment. |
| **Gemini 1.5 Pro / 3.6 Flash** | Synthesis, Evaluation Suites & Documentation | Generating synthetic telemetry seeds, test assertion suites, and user documentation. |

### Division of Responsibility
- **Delegated to AI (Wholesale):** React CSS styling, Mapbox layer rendering hooks, REST CRUD boilerplate, synthetic data seeding scripts, and Dockerfile configurations.
- **Hand-Authored / Rigorously Reviewed:** The core graph boundary localization algorithm, spatial minimum spanning tree fallback logic for 60% missing topology, telemetry deduplication logic, and automated restoration verification rules.

---

## 2. Concrete Cases Where AI Was Wrong or Misleading

### Case 1: AI Suggested Graph Centrality for Fault Localization
- **What AI Produced:** Cursor initially suggested running closeness centrality and PageRank on the pole network to find "critical nodes" experiencing outages.
- **Why It Was Wrong:** In a radial power tree, centrality algorithms highlight high-degree transformers, not the physical broken line span. An outage on a leaf spur pole would be ignored or misclassified.
- **How It Was Caught & Fixed:** Caught during unit testing on a 5-pole test graph. Replaced with a deterministic Live-to-Dark Frontier boundary search algorithm.

### Case 2: Silent Swallowing of Capacitor-Reserve Telemetry Packets
- **What AI Produced:** The generated ingest controller discarded incoming telemetry missing a `power_lost` event string or having `battery_mv < 3200`.
- **Why It Was Wrong:** Real IoT field devices frequently drain capacitor reserves during faults, failing to send `power_lost` 30% of the time. Discarding them caused dark poles to be treated as healthy.
- **How It Was Caught & Fixed:** Identified when running monsoon burst simulations. Fixed by maintaining a sliding-window `last_seen` watchdog that interprets silent poles downstream of a dark frontier as powered-down nodes.

---

## 3. Code Generation Statistics

- **Total Codebase Volume:** ~3,850 lines of code.
- **Estimated AI-Generated Code:** **75%** (Boilerplate, UI components, seed generators, API endpoints).
- **Estimated Human-Refined Code:** **25%** (Algorithm design, graph boundary math, edge-case unit tests, architecture docs).

---

## 4. Exemplary Prompts & RFC Specifications

### Prompt Example: Boundary Frontier Localization Engine
```text
Write a TypeScript function `findFaultBoundaries(graph: TreeGraph, telemetry: Map<PoleID, PoleState>)` 
for a radial electrical distribution tree. 
Constraints:
1. Find all edges (P_upstream, P_downstream) where P_upstream is LIVE (or is the DT) and P_downstream is DARK.
2. Group all dark nodes downstream of P_downstream into a single FaultIncident object to avoid multi-alerting.
3. If a dark node has LIVE children downstream, mark it as a SENSOR_FAULT, not a line outage.
4. Return an array of localized FaultIncident objects with confidence scores.
```
