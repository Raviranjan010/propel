# Karnataka State Power Distribution Board (KSPDB) - Automated Fault Localization & Verification System

[![Docker Compose](https://img.shields.io/badge/Docker-compose_up-blue.svg)](file:///d:/Temp/propel/docker-compose.yml)
[![Live Demo](https://img.shields.io/badge/Live_Demo-Reachable_URL-green.svg)]([REPLACE: real live deploy URL])
[![Demo Video](https://img.shields.io/badge/Demo_Video-5--Min_Loom-red.svg)]([REPLACE: real demo video URL])

> An end-to-end AI-assisted telemetry ingestion, fault localization, and automated ticket lifecycle management system built for the Karnataka State Power Distribution Board (KSPDB). Compresses the 2-hour manual pole-walking fault identification window down to **< 30 seconds**.

---

## 🚀 Quick Start (One-Command Launch)

Ensure you have Docker and Docker Compose installed.

```bash
git clone [REPLACE: real GitHub repo URL]
cd kspdb-fault-locator
docker compose up --build
```

The system will build all containers, run database migrations, and **automatically seed a synthetic network** across substations, feeders, and distribution transformers (with 60% unmapped topology).

- **Operator Console, Dashboard & Fault Simulator:** [http://localhost:8000](http://localhost:8000)
- **REST & Telemetry Ingestion API:** [http://localhost:8000](http://localhost:8000)
- **API Health Check:** `curl http://localhost:8000/health`

---

## 🌐 Public Deliverables

- **Public Repository (GitHub):** [REPLACE: real GitHub repo URL]
- **Live Public URL:** [REPLACE: real live deploy URL] *(Note: Hosted on free-tier platform with auto-cold-start, please allow up to 20s on first load)*
- **5-Minute Demo Video:** [REPLACE: real demo video URL]

---

## 🗺️ Documentation Directory

| Document | Description |
| :--- | :--- |
| 📐 [**`ARCHITECTURE.md`**](file:///d:/Temp/propel/ARCHITECTURE.md) | Ingestion pipeline, graph representation, graph-boundary localization algorithm, probabilistic estimation for 60% missing topology, noise/load-shedding handling, and AI operator copilot architecture. |
| 🛠️ [**`DEPLOYMENT.md`**](file:///d:/Temp/propel/DEPLOYMENT.md) | Prerequisites, environment variables, step-by-step production setup, docker verification, and exhaustive troubleshooting guide. |
| ⚖️ [**`DECISIONS.md`**](file:///d:/Temp/propel/DECISIONS.md) | Architectural decision record (ADR), trade-offs, explicit assumptions made under ambiguity, 2-week roadmap, and known limitations. |
| 🤖 [**`AI-WORKFLOW.md`**](file:///d:/Temp/propel/AI-WORKFLOW.md) | Documentation of AI agent usage (Claude Opus / Cursor), RFC specification-driven engineering, failure cases, prompt engineering strategies, and code attribution. |

---

## ⚡ Key Capabilities & Architecture Highlights

1. **Sub-Minute Span Fault Localization:** Identifies the precise break span between Pole $P_n$ and Pole $P_{n+1}$, lat/lon GPS coordinates, and ward/PIN code in < 30 seconds.
2. **Probabilistic Boundary Localization for 60% Unmapped Topology:** Uses spatial minimum spanning trees (MST), convex hull bounding, and historical co-outage graph clustering to localise faults even when `seq_on_line` and `parent_pole_id` are absent.
3. **Telemetry Ingestion & Noise Filtering:** Tolerates steady-state 39 msg/s and 5,000 msg bursts. Filters firmware 1.2 silent deaths, capacitor-reserve lost packets (30% loss rate), duplicate packets, clock skew ($\pm 90$s), and scheduled load shedding.
4. **Telemetry-Verified Ticket Closure:** Tickets cannot be closed manually by a lineman. Auto-verifies restoration only when downstream pole heartbeats and `power_restored` telemetry confirm active current flow.
5. **Interactive Fault Simulator:** Built-in web UI & CLI tool to inject single/multiple span faults, DT failures, feeder outages, scheduled load shedding, and dead IoT modems.