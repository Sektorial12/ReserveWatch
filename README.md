# ReserveWatch (CRE Hackathon)

ReserveWatch is an institutional-grade Proof of Reserves (PoR) and Net Asset Value (NAV) monitoring system for tokenized RWAs.

It uses Chainlink Runtime Environment (CRE) to orchestrate:

- Scheduled reserve checks (Cron Trigger)
- External reserve data ingestion (HTTP Capability)
- Onchain state reads (EVM Read Capability)
- Onchain attestations and automated safeguards (EVM Write Capability)

## Target chain
- Ethereum Sepolia (Chainlink CRE docs/templates default)

## Repository layout
- `reservewatch-workflow/`: CRE TypeScript workflow (simulation + onchain write)
- `contracts/evm/`: Solidity consumer contract(s) that receive CRE reports via `onReport(bytes,bytes)`
- `contracts/abi/`: TypeScript ABIs used by the workflow (Viem)
- `server/`: Local reserve API used as an external data source for simulation (also serves the Console at `/console`)

## Quick start (high level)
1. Start the reserve API (`server/`)
2. (Optional) Configure multi-project onboarding via `server/projects.json`
3. Deploy contracts for simulation (use the Sepolia MockForwarder address)
4. Update `reservewatch-workflow/config.staging.json` with deployed addresses (or use the deploy script which updates it automatically)
5. Run the end-to-end demo runner (`scripts/demo.mjs`) to broadcast a healthy + unhealthy attestation

See `DEMO.md` for a step-by-step runbook (Console + demo runner + on-chain verification).

## Local run (simulation)

### 1) Reserve API (external data source)
- Run the server from `server/`
- Default mode is `healthy` (can be switched to `unhealthy`)

Start:
- `cd server && npm start`

Endpoints:
- `GET http://127.0.0.1:8787/reserve/source-a`
- `GET http://127.0.0.1:8787/reserve/source-b`
- `POST http://127.0.0.1:8787/admin/mode` with JSON: `{ "mode": "healthy" | "unhealthy" }`

Incident monitoring (optional):
- `GET http://127.0.0.1:8787/incident/feed?project=<id>`
- `POST http://127.0.0.1:8787/admin/incident`

Reserve payloads include:
- `reserveUsd` (required)
- `navUsd` (optional)
- `signer` + `signature` (optional, when `RESERVE_SIGNING_PRIVATE_KEY` is set)

Console + API:
- `GET http://127.0.0.1:8787/console`
- `GET http://127.0.0.1:8787/api/status?project=<id>`
- `GET http://127.0.0.1:8787/api/history?project=<id>&limit=10`

### 2) Deploy contracts for simulation
CRE simulation uses a **MockForwarder**. For Ethereum Sepolia, the docs reference:

- MockForwarder: `0x15fC6ae953E024d975e77382eEeC56A9101f9F88`

Deploy order:
1. Deploy `LiabilityToken`
2. Deploy `ReserveWatchReceiver(forwarder, liabilityToken, minCoverageBps)`
3. Set token guardian to the receiver (`LiabilityToken.setGuardian(receiver)`)

If you use `contracts/evm/deploy.js`, it will also update:
- `reservewatch-workflow/config.staging.json` (addresses + `attestationVersion`)
- `server/projects.json` (addresses for `reservewatch-sepolia`)

### 3) Configure workflow
Edit:
- `reservewatch-workflow/config.staging.json`

Set:
- `receiverAddress` to the deployed `ReserveWatchReceiver`
- `liabilityTokenAddress` to the deployed `LiabilityToken`

Optional:
- `attestationVersion`: `v1` (no NAV onchain) or `v2` (publish NAV onchain)

EVM read policy (optional):
- `evmReadBlockTag`: `finalized` (default) or `latest`
- `evmReadFallbackToLatest`: `true` (default) to retry reads against the other tag if the primary returns empty data
- `evmReadRetries`: number of extra attempts per block tag (string)

### 4) Run CRE simulation
From the repo root:

- Ensure `.env` contains a funded Sepolia private key:
  - `CRE_ETH_PRIVATE_KEY=...`

- Recommended (end-to-end demo runner):
  - `node scripts/demo.mjs --broadcast --api http://127.0.0.1:8787 --project reservewatch-sepolia --timeout 120`

- Manual (single run):
  - `cre workflow simulate reservewatch-workflow --target staging-settings --broadcast --env .env`

If you have a proxy configured in your shell environment, you may need:
- `curl --noproxy '*' ...`

## Files that use Chainlink/CRE
- `reservewatch-workflow/main.ts`
- `reservewatch-workflow/workflow.yaml`
- `project.yaml`
