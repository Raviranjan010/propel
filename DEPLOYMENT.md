# KSPDB Automated Fault Localization System — Deployment Guide

This guide provides step-by-step instructions to deploy, run, verify, and troubleshoot the KSPDB Automated Fault Localization & Verification system.

---

## 1. Prerequisites

- **Docker Engine:** Version 24.0.0 or higher
- **Docker Compose:** Version 2.20.0 or higher (V2 plugin syntax `docker compose`)
- **System Memory:** Minimum 4 GB RAM available
- **Network:** Outbound HTTP/HTTPS access for downloading container base images

---

## 2. Environment Variables & Configuration

Copy the example environment file before starting:

```bash
cp .env.example .env
```

### Environment Variable Reference

| Variable Name | Required | Default Value | Description |
| :--- | :---: | :--- | :--- |
| `PORT` | Yes | `8000` | Ingestion API & SCADA Console Port |
| `DATABASE_URL` | Yes | `postgresql://kspdb:kspdb_pass@db:5432/kspdb_db` | PostgreSQL connection string |
| `POSTGRES_USER` | Yes | `kspdb` | PostgreSQL database user |
| `POSTGRES_PASSWORD` | Yes | `kspdb_pass` | PostgreSQL database password |
| `POSTGRES_DB` | Yes | `kspdb_db` | PostgreSQL database name |
| `LLM_API_KEY` | No | *(empty)* | Gemini/OpenAI API key for operator copilot (falls back to deterministic template if empty) |
| `SEED_POLE_COUNT` | No | `5000` | Number of synthetic poles generated on startup |
| `UNMAPPED_TOPOLOGY_RATIO` | No | `0.60` | Ratio of DTs with missing `seq_on_line` (60%) |

---

## 3. One-Command Production Launch

To build, seed, and launch the complete stack:

```bash
docker compose up --build -d
```

### What happens on launch:
1. `db` container initializes PostgreSQL database.
2. `app` container compiles TypeScript, seeds synthetic network data, builds topology graphs, and launches the Express server on port 8000.

---

## 4. How to Verify Deployment

1. **Check Container Status:**
   ```bash
   docker compose ps
   ```
   All services (`db`, `app`) should display `Up (healthy)`.

2. **Verify Ingestion Health Endpoint:**
   ```bash
   curl http://localhost:8000/health
   ```
   Expected response: `{"status":"healthy","database":"connected","poles_loaded":3000}`.

3. **Open Operator Console:**
   Navigate to [http://localhost:8000](http://localhost:8000) in your web browser. You will immediately see the seeded Karnataka subdivision map with live pole statuses and built-in fault simulator panel.

4. **Run Automated End-to-End Verification Test:**
   ```bash
   docker compose exec app npm test
   ```

---

## 5. Troubleshooting Guide & Common Failure Modes

### 1. Port 8000 Already in Use
- **Symptom:** `Error: listen EADDRINUSE: address already in use :::8000`.
- **Fix:** Update `PORT` in your `.env` file, or terminate conflicting local processes:
  ```bash
  # Windows PowerShell
  Stop-Process -Id (Get-NetTCPConnection -LocalPort 8000).OwningProcess -Force
  ```

### 2. Database Migration Race Condition on Startup
- **Symptom:** App container crashes with `Connection refused at postgresql://db:5432`.
- **Fix:** `docker-compose.yml` includes a `healthcheck` on the database container. If running manually, restart app:
  ```bash
  docker compose restart app
  ```

### 3. ARM64 (Apple Silicon M1/M2/M3) vs x86 Architecture Build Issues
- **Symptom:** `exec format error` or slow emulation when building PostGIS images.
- **Fix:** Dockerfile uses multi-arch base images. Ensure Docker Desktop has "Use Rosetta for x86/amd64 emulation" enabled.

### 4. WebSocket Upgrade Blocked Behind Reverse Proxy (Render/Nginx)
- **Symptom:** UI falls back to polling; console error `WebSocket connection to 'wss://...' failed`.
- **Fix:** Ensure HTTP headers `Upgrade` and `Connection: Upgrade` are passed in reverse proxy settings. The app automatically degrades gracefully to 3-second HTTP polling if WebSockets are blocked.

---

## 6. How to Reset to a Clean State

To wipe all data, reset database state, and re-seed from scratch:

```bash
docker compose down -v
docker compose up --build
```
