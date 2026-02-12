# ReserveWatch Console — UI Guidance

This document describes the intended ReserveWatch Console UX for the Product MVP (Level B: Monitoring + Enforcement).

The UI is an operator console for an issuer’s risk/compliance team. It should answer:
- “Is the asset healthy right now?”
- “Is enforcement active onchain?”
- “Why is it healthy/unhealthy?”
- “What changed recently?”

## Target user
- Issuer risk/compliance operator
- Secondary: integrators/auditors who want verifiable state + history

## Core concepts surfaced in UI
- Offchain reserves (multiple sources)
- Onchain liabilities (token/vault supply)
- Coverage ratio (bps) and policy threshold
- Staleness / source mismatch
- Onchain attestation state (receiver contract)
- Enforcement state (minting enabled/paused)

## Required screens (MVP)

### 1) Overview / Live Status
Purpose: single-pane-of-glass “what’s the health + enforcement status right now?”

Components:
- Health badge: HEALTHY | UNHEALTHY | DEGRADED | STALE
- KPI cards:
  - Coverage bps vs min threshold
  - Minting status (enabled/paused)
  - Data freshness (age of last reserve update)
  - Source agreement (e.g., 2/2 agree)
- Reserve sources table:
  - source id
  - reserveUsd
  - asOf timestamp
  - age
  - status (ok/stale/error)
- Onchain panel:
  - Receiver: lastAttestationHash, lastReserveUsd, lastLiabilitySupply, lastCoverageBps, lastAsOfTimestamp, minCoverageBps, mintingPaused
  - Token/Vault: totalSupply, mintingEnabled, guardian
- Explorer links:
  - receiver address
  - token address
  - most recent tx hash (if provided)

Behavior:
- Auto-refresh/polling every 5–10 seconds.
- Clear “last refreshed” timestamp.
- If `onchain.error` exists, show a visible warning but keep rendering last-known data.

### 2) History / Audit (minimal)
Purpose: show recent attestations and breaker events for credibility.

Options:
- If backend provides it: table of last N attestations (timestamp, coverage, status, txHash).
- If not available yet: show “latest attestation only” plus links to explorer/event logs.

### 3) Settings (read-only in MVP is fine)
Purpose: make it feel production-ready.

Show:
- Policy: minCoverageBps, staleness threshold
- Config: receiver address, liability token address, chain, RPC URL
- Sources: list of reserve source endpoints

## Demo-only controls
For hackathon/demo mode, include:
- Toggle “Reserve API mode”: healthy/unhealthy
  - Calls `POST /admin/mode` with `{ "mode": "healthy" | "unhealthy" }`

In production, this toggle should be removed.

## API contract the UI expects

### `GET /api/status`
UI should be built around a single JSON payload.

Recommended shape:
```json
{
  "mode": "healthy",
  "reserves": {
    "primary": { "source": "source-a", "timestamp": 1700000000, "reserveUsd": "1200000" },
    "secondary": { "source": "source-b", "timestamp": 1700000000, "reserveUsd": "1200000" }
  },
  "onchain": {
    "rpcUrl": "https://...",
    "blockNumber": "...",
    "receiverAddress": "0x...",
    "liabilityTokenAddress": "0x...",
    "receiver": {
      "lastAttestationHash": "0x...",
      "lastReserveUsd": "...",
      "lastLiabilitySupply": "...",
      "lastCoverageBps": "...",
      "lastAsOfTimestamp": "...",
      "mintingPaused": false,
      "minCoverageBps": "..."
    },
    "token": {
      "totalSupply": "...",
      "mintingEnabled": true,
      "guardian": "0x..."
    },
    "error": "optional string"
  }
}
```

Notes:
- Treat large numbers as strings.
- `onchain.error` should not break the UI; display it as a warning.

### `POST /admin/mode` (demo)
Request:
```json
{ "mode": "healthy" }
```
Response:
```json
{ "mode": "healthy" }
```

## States & UX rules
- Always show:
  - current health badge
  - last updated / staleness indicator
  - enforcement status
- Health logic for display (suggested):
  - STALE if any required source is older than threshold or missing
  - DEGRADED if sources disagree beyond a configured delta
  - UNHEALTHY if coverage below threshold (or `mintingPaused=true`)
  - HEALTHY otherwise

## Visual design guidance
- Clean, minimal, “ops console” look.
- Use strong color only for the health badge and incident banner.
- Make explorer links prominent (credibility signal).

## Implementation notes
- Keep UI stateless; rely on polling `GET /api/status`.
- Support dark mode if easy, but not required.
