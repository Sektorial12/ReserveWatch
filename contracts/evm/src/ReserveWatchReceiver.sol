// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";
import {LiabilityToken} from "./LiabilityToken.sol";

contract ReserveWatchReceiver is ReceiverTemplate {
  error ReportCallFailed();
  error OnlySelf(address sender);
  error CoverageMismatch(uint256 received, uint256 computed);
  error BreakerMismatch(bool received, bool computed);

  event AttestationPublished(
    bytes32 indexed attestationHash,
    uint256 reserveUsd,
    uint256 liabilitySupply,
    uint256 coverageBps,
    uint256 asOfTimestamp,
    bool breakerTriggered
  );

  event AttestationPublishedV2(
    bytes32 indexed attestationHash,
    uint256 reserveUsd,
    uint256 navUsd,
    uint256 liabilitySupply,
    uint256 coverageBps,
    uint256 asOfTimestamp,
    bool breakerTriggered
  );

  event CircuitBreakerTriggered(bytes32 indexed attestationHash, uint256 coverageBps, uint256 minCoverageBps);

  bytes32 public lastAttestationHash;
  uint256 public lastReserveUsd;
  uint256 public lastNavUsd;
  uint256 public lastLiabilitySupply;
  uint256 public lastCoverageBps;
  uint256 public lastAsOfTimestamp;

  bool public mintingPaused;

  uint256 public minCoverageBps;
  LiabilityToken public immutable liabilityToken;

  constructor(address forwarderAddress, address liabilityTokenAddress, uint256 minCoverageBps_) ReceiverTemplate(forwarderAddress) {
    liabilityToken = LiabilityToken(liabilityTokenAddress);
    minCoverageBps = minCoverageBps_;
  }

  function setMinCoverageBps(uint256 newMinCoverageBps) external onlyOwner {
    minCoverageBps = newMinCoverageBps;
  }

  function _processReport(bytes calldata report) internal override {
    (bool ok, ) = address(this).call(report);
    if (!ok) revert ReportCallFailed();
  }

  function updateAttestation(
    bytes32 attestationHash,
    uint256 reserveUsd,
    uint256 liabilitySupply,
    uint256 coverageBps,
    uint256 asOfTimestamp,
    bool breakerTriggered
  ) external {
    if (msg.sender != address(this)) revert OnlySelf(msg.sender);

    uint256 computedCoverageBps = 0;
    if (liabilitySupply != 0) {
      computedCoverageBps = (reserveUsd * 10000) / liabilitySupply;
    }

    if (coverageBps != computedCoverageBps) {
      revert CoverageMismatch(coverageBps, computedCoverageBps);
    }

    bool shouldPause = coverageBps < minCoverageBps;

    if (breakerTriggered != shouldPause) {
      revert BreakerMismatch(breakerTriggered, shouldPause);
    }

    lastAttestationHash = attestationHash;
    lastReserveUsd = reserveUsd;
    lastLiabilitySupply = liabilitySupply;
    lastCoverageBps = coverageBps;
    lastAsOfTimestamp = asOfTimestamp;

    mintingPaused = shouldPause;
    liabilityToken.setMintingEnabled(!shouldPause);

    emit AttestationPublished(attestationHash, reserveUsd, liabilitySupply, coverageBps, asOfTimestamp, breakerTriggered);

    if (shouldPause) {
      emit CircuitBreakerTriggered(attestationHash, coverageBps, minCoverageBps);
    }
  }

  function updateAttestationV2(
    bytes32 attestationHash,
    uint256 reserveUsd,
    uint256 navUsd,
    uint256 liabilitySupply,
    uint256 coverageBps,
    uint256 asOfTimestamp,
    bool breakerTriggered
  ) external {
    if (msg.sender != address(this)) revert OnlySelf(msg.sender);

    uint256 computedCoverageBps = 0;
    if (liabilitySupply != 0) {
      computedCoverageBps = (reserveUsd * 10000) / liabilitySupply;
    }

    if (coverageBps != computedCoverageBps) {
      revert CoverageMismatch(coverageBps, computedCoverageBps);
    }

    bool shouldPause = coverageBps < minCoverageBps;

    if (breakerTriggered != shouldPause) {
      revert BreakerMismatch(breakerTriggered, shouldPause);
    }

    lastAttestationHash = attestationHash;
    lastReserveUsd = reserveUsd;
    lastNavUsd = navUsd;
    lastLiabilitySupply = liabilitySupply;
    lastCoverageBps = coverageBps;
    lastAsOfTimestamp = asOfTimestamp;

    mintingPaused = shouldPause;
    liabilityToken.setMintingEnabled(!shouldPause);

    emit AttestationPublishedV2(attestationHash, reserveUsd, navUsd, liabilitySupply, coverageBps, asOfTimestamp, breakerTriggered);

    if (shouldPause) {
      emit CircuitBreakerTriggered(attestationHash, coverageBps, minCoverageBps);
    }
  }
}
