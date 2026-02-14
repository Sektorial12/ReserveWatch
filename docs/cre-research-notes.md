# Chainlink CRE research notes (web search)

This note captures the key points gathered from web/MCP search while building ReserveWatch.

## Source links used

- Part 4: Writing Onchain (TypeScript)
  - https://docs.chain.link/cre/getting-started/part-4-writing-onchain-ts
- Onchain Write overview (TypeScript)
  - https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/overview-ts
- CRE main docs
  - https://docs.chain.link/cre
- API interactions (HTTP client)
  - https://docs.chain.link/cre/guides/workflow/using-http-client
- Onchain Read guide
  - https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-read-ts
- Cron Trigger guide
  - https://docs.chain.link/cre/guides/workflow/using-triggers/cron-trigger-go
- CRE use-cases article
  - https://blog.chain.link/5-ways-to-build-with-cre/

## Relevant takeaways for ReserveWatch

1. CRE write flow is intentionally 2-step in workflow code:
   - `runtime.report(...)` to create a signed report.
   - `evmClient.writeReport(...)` to submit the report to the receiver.

2. Receiver model:
   - CRE does not write directly to arbitrary business methods.
   - The trusted forwarder verifies signatures and calls `onReport(bytes,bytes)` on the receiver contract.

3. Trigger/callback model:
   - Cron trigger + callback is the standard periodic risk-monitoring architecture.
   - 5-field and 6-field cron expressions are supported; 6-field includes seconds.

4. HTTP capability guidance:
   - Workflows can ingest external APIs via HTTP capability.
   - For consensus-safe time values, docs recommend runtime-based time sources instead of local wall clock assumptions.

5. EVM read/write alignment:
   - Viem ABI encoding/decoding patterns used in ReserveWatch are aligned with docs.
   - The pattern of reading onchain state before computing attestation is the expected implementation style.

## Why this matters for this repo

`reservewatch-workflow/main.ts` already follows the documented CRE architecture:

- Cron trigger
- HTTP reserve fetch
- EVM read (liability supply + policy read)
- report generation + onchain write to receiver

So the current design is aligned with public CRE patterns and hackathon expectations.
