# ReserveWatch contract gaps and hardening backlog

This document lists contract-side gaps observed after frontend implementation.

## 1) Replay / stale attestation acceptance

- Current receiver accepts updates without monotonic timestamp checks.
- Impact: older reports could overwrite newer healthy state.

### Recommendation

- Enforce monotonicity:
  - `require(asOfTimestamp >= lastAsOfTimestamp, "stale attestation")`
- Optional stricter policy:
  - `require(asOfTimestamp > lastAsOfTimestamp)`

## 2) `attestationHash` is not verified onchain

- Contract stores and emits `attestationHash` but does not recompute and compare it to payload fields.
- Impact: integrity relies on offchain workflow correctness and trusted forwarder path.

### Recommendation

- Recompute inside `updateAttestation` / `updateAttestationV2` and assert equality.
- Keep hash formula versioned (`v1`/`v2`) to avoid migration ambiguity.

## 3) Supply source trust model

- Coverage is validated against `liabilitySupply` supplied in report payload.
- Contract does not cross-check with `liabilityToken.totalSupply()`.

### Recommendation

- Add optional strict mode:
  - compare reported `liabilitySupply` to current token supply.
- If strict mode can cause liveness issues, at least emit mismatch event and force degraded state.

## 4) Forwarder safety mode can be disabled

- `ReceiverTemplate.setForwarderAddress` allows zero address.
- Contract emits warning but remains callable by anyone when forwarder is zero.

### Recommendation

- For production deployments:
  - disallow zero address entirely, or
  - add explicit `unsafeMode` switch requiring two-step timelocked governance.

## 5) Governance / role controls are minimal

- `setMinCoverageBps` has no event.
- No timelock / delay for sensitive policy changes.

### Recommendation

- Emit `MinCoverageBpsUpdated(oldValue, newValue)`.
- Use delayed governance owner for production (timelock multisig).

## 6) Test suite needs adversarial coverage

Current tests are strong happy-path checks, but missing revert-path invariants.

### Add tests for

- `CoverageMismatch`
- `BreakerMismatch`
- unauthorized sender to `onReport`
- stale attestation replay rejection (after adding monotonic check)
- zero-forwarder behavior (if retained)

## Priority order (suggested)

1. Add monotonic timestamp guard.
2. Add attestation hash verification.
3. Add events for governance changes.
4. Expand revert-path tests.
5. Decide strict/non-strict supply cross-check policy.
