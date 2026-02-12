# Demo Guide

## Prerequisites
- CRE CLI installed (`cre whoami`)
- Funded Sepolia account (private key set in `.env`)
- `solc` Solidity compiler available

**Important**: Update `.env` with your actual Sepolia private key (not the placeholder) before deployment.

## 1) Deploy contracts (simulation)

If Foundry is available:
```bash
cd contracts/evm
forge script script/Deploy.s.sol --rpc-url https://ethereum-sepolia-rpc.publicnode.com --private-key $CRE_ETH_PRIVATE_KEY --broadcast
```

Otherwise, use Node.js with viem:
```bash
cd contracts/evm
npm install viem
node deploy.js
```

Or use the Makefile for manual deployment:
```bash
cd contracts/evm
make deploy
```

From the deployment logs, capture:
- `LiabilityToken` address
- `ReserveWatchReceiver` address

## 2) Configure workflow

Edit `reservewatch-workflow/config.staging.json`:

```json
{
  "schedule": "*/30 * * * * *",
  "chainSelectorName": "ethereum-testnet-sepolia",
  "receiverAddress": "<ReserveWatchReceiver address>",
  "liabilityTokenAddress": "<LiabilityToken address>",
  "reserveUrlPrimary": "http://127.0.0.1:8787/reserve/source-a",
  "reserveUrlSecondary": "http://127.0.0.1:8787/reserve/source-b",
  "evmReadBlockTag": "finalized",
  "evmReadFallbackToLatest": true,
  "evmReadRetries": "1",
  "minCoverageBps": "10000",
  "gasLimit": "1000000",
  "attestationVersion": "v2"
}
```

Notes:
- When `attestationVersion` is `v2`, the workflow publishes `navUsd` onchain (requires a receiver deployment that includes `updateAttestationV2` and `lastNavUsd`).

## 3) Start reserve API (if not running)

```bash
cd server
npm start
```

Console:
- http://127.0.0.1:8787/console

## 4) (Optional) Configure multi-project onboarding

The Console and API support multiple assets/projects via `server/projects.json`.

- Copy the template:
  - `server/projects.example.json` -> `server/projects.json`

Then use `?project=<id>` in the Console URL and API calls.

## 5) Run end-to-end demo (recommended)

From the repo root:

```bash
node scripts/demo.mjs --broadcast --api http://127.0.0.1:8787 --project reservewatch-sepolia --timeout 120
```

This will:
- set reserves to healthy, broadcast a healthy attestation
- set reserves to unhealthy, broadcast an unhealthy attestation
- wait for `/api/status` to reflect onchain state

## 6) Manual mode (if you don’t want the demo runner)

### 6.1) Run simulation (healthy)

```bash
# From project root
curl -X POST http://127.0.0.1:8787/admin/mode -H "Content-Type: application/json" -d '{"mode":"healthy"}'
cre workflow simulate reservewatch-workflow --target staging-settings --broadcast --env .env
```

Expected logs:
- `reserveUsd=1200000 supply=... coverageBps=12000`
- `breakerTriggered=false`
- Onchain `txStatus` and `receiverStatus` success

### 6.2) Flip to unhealthy reserves

```bash
curl -X POST http://127.0.0.1:8787/admin/mode -H "Content-Type: application/json" -d '{"mode":"unhealthy"}'
```

### 6.3) Run simulation (unhealthy)

```bash
cre workflow simulate reservewatch-workflow --target staging-settings --broadcast --env .env
```

Expected logs:
- `reserveUsd=900000 supply=... coverageBps=9000`
- `breakerTriggered=true`
- Onchain `txStatus` and `receiverStatus` success

## 7) Verify (Console + API)

- Status:
  - `curl -sS --noproxy '*' 'http://127.0.0.1:8787/api/status?project=reservewatch-sepolia' | jq .derived`

- History (recent attestations):
  - `curl -sS --noproxy '*' 'http://127.0.0.1:8787/api/history?project=reservewatch-sepolia&limit=5' | jq .events`

- Incident feed (optional):
  - `curl -sS --noproxy '*' 'http://127.0.0.1:8787/incident/feed?project=reservewatch-sepolia' | jq .`
  - `curl -sS --noproxy '*' -X POST 'http://127.0.0.1:8787/admin/incident' -H 'content-type: application/json' --data-raw '{"projectId":"reservewatch-sepolia","active":true,"severity":"warning","message":"custodian downtime"}' | jq .`

## 8) Verify onchain state (optional)

Use `cast` or a block explorer to query:
- `ReserveWatchReceiver.lastAttestationHash()`
- `ReserveWatchReceiver.lastCoverageBps()`
- `ReserveWatchReceiver.lastNavUsd()` (if v2)
- `ReserveWatchReceiver.mintingPaused()`
- `LiabilityToken.mintingEnabled()`

Verified Sepolia broadcasts (reference):
- healthy: `0x036a30078ced0df628d0e89be97a47bcdfcbb53099ed5c9b82df1cb8b4c02f24`
- unhealthy: `0x1d34ff3a27b85b3e3cc85f5ad93b117f0e812353ea804fd0c90a1c209fcc2ea4`

One-command verifier (Node + viem, run from `reservewatch-workflow/`):
```bash
node --input-type=module -e '
import { createPublicClient, http, parseAbi } from "viem";
import { sepolia } from "viem/chains";

const rpc = "https://ethereum-sepolia-rpc.publicnode.com";
const receiver = process.env.RECEIVER_ADDRESS;
const token = process.env.TOKEN_ADDRESS;
if (!receiver || !token) throw new Error("Set RECEIVER_ADDRESS and TOKEN_ADDRESS");

const client = createPublicClient({ chain: sepolia, transport: http(rpc) });

const receiverAbi = parseAbi([
  "function lastAttestationHash() view returns (bytes32)",
  "function lastReserveUsd() view returns (uint256)",
  "function lastLiabilitySupply() view returns (uint256)",
  "function lastCoverageBps() view returns (uint256)",
  "function lastAsOfTimestamp() view returns (uint256)",
  "function mintingPaused() view returns (bool)",
]);

let lastNavUsd = null;
try {
  const navAbi = parseAbi(["function lastNavUsd() view returns (uint256)"]);
  lastNavUsd = (await client.readContract({ address: receiver, abi: navAbi, functionName: "lastNavUsd" })).toString();
} catch {
  lastNavUsd = null;
}

const tokenAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function mintingEnabled() view returns (bool)",
  "function guardian() view returns (address)",
]);

console.log("receiverState:", {
  lastAttestationHash: await client.readContract({ address: receiver, abi: receiverAbi, functionName: "lastAttestationHash" }),
  lastReserveUsd: (await client.readContract({ address: receiver, abi: receiverAbi, functionName: "lastReserveUsd" })).toString(),
  lastNavUsd,
  lastLiabilitySupply: (await client.readContract({ address: receiver, abi: receiverAbi, functionName: "lastLiabilitySupply" })).toString(),
  lastCoverageBps: (await client.readContract({ address: receiver, abi: receiverAbi, functionName: "lastCoverageBps" })).toString(),
  lastAsOfTimestamp: (await client.readContract({ address: receiver, abi: receiverAbi, functionName: "lastAsOfTimestamp" })).toString(),
  mintingPaused: await client.readContract({ address: receiver, abi: receiverAbi, functionName: "mintingPaused" }),
});

console.log("tokenState:", {
  totalSupply: (await client.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply" })).toString(),
  mintingEnabled: await client.readContract({ address: token, abi: tokenAbi, functionName: "mintingEnabled" }),
  guardian: await client.readContract({ address: token, abi: tokenAbi, functionName: "guardian" }),
});
'
```
