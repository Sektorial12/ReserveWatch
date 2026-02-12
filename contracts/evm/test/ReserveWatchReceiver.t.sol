// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LiabilityToken} from "../src/LiabilityToken.sol";
import {ReserveWatchReceiver} from "../src/ReserveWatchReceiver.sol";

contract ReserveWatchReceiverTest {
  function test_onReport_updatesState_and_triggersBreaker() public {
    LiabilityToken token = new LiabilityToken();
    ReserveWatchReceiver receiver = new ReserveWatchReceiver(address(this), address(token), 10000);

    token.setGuardian(address(receiver));

    uint256 reserveUsd = 900_000;
    uint256 supply = 1_000_000;
    uint256 coverageBps = (reserveUsd * 10000) / supply;
    bool breaker = coverageBps < 10000;

    bytes32 attestationHash = keccak256(abi.encode(reserveUsd, supply, coverageBps, uint256(123), breaker));

    bytes memory callData = abi.encodeWithSelector(
      receiver.updateAttestation.selector,
      attestationHash,
      reserveUsd,
      supply,
      coverageBps,
      uint256(123),
      breaker
    );

    receiver.onReport("", callData);

    assert(receiver.lastAttestationHash() == attestationHash);
    assert(receiver.lastReserveUsd() == reserveUsd);
    assert(receiver.lastLiabilitySupply() == supply);
    assert(receiver.lastCoverageBps() == coverageBps);
    assert(receiver.lastAsOfTimestamp() == 123);

    assert(receiver.mintingPaused());
    assert(!token.mintingEnabled());
  }

  function test_onReport_v2_updatesState_and_storesNav() public {
    LiabilityToken token = new LiabilityToken();
    ReserveWatchReceiver receiver = new ReserveWatchReceiver(address(this), address(token), 10000);

    token.setGuardian(address(receiver));

    uint256 reserveUsd = 1_200_000;
    uint256 navUsd = 1_195_000;
    uint256 supply = 1_000_000;
    uint256 coverageBps = (reserveUsd * 10000) / supply;
    bool breaker = coverageBps < 10000;

    bytes32 attestationHash = keccak256(abi.encode(reserveUsd, navUsd, supply, coverageBps, uint256(123), breaker));

    bytes memory callData = abi.encodeWithSelector(
      receiver.updateAttestationV2.selector,
      attestationHash,
      reserveUsd,
      navUsd,
      supply,
      coverageBps,
      uint256(123),
      breaker
    );

    receiver.onReport("", callData);

    assert(receiver.lastAttestationHash() == attestationHash);
    assert(receiver.lastReserveUsd() == reserveUsd);
    assert(receiver.lastNavUsd() == navUsd);
    assert(receiver.lastLiabilitySupply() == supply);
    assert(receiver.lastCoverageBps() == coverageBps);
    assert(receiver.lastAsOfTimestamp() == 123);

    assert(!receiver.mintingPaused());
    assert(token.mintingEnabled());
  }

  function test_onReport_unpauses_when_healthy() public {
    LiabilityToken token = new LiabilityToken();
    ReserveWatchReceiver receiver = new ReserveWatchReceiver(address(this), address(token), 10000);

    token.setGuardian(address(receiver));

    {
      uint256 reserveUsd = 900_000;
      uint256 supply = 1_000_000;
      uint256 coverageBps = (reserveUsd * 10000) / supply;
      bool breaker = coverageBps < 10000;
      bytes32 attestationHash = keccak256(abi.encode(reserveUsd, supply, coverageBps, uint256(123), breaker));
      bytes memory callData = abi.encodeWithSelector(
        receiver.updateAttestation.selector,
        attestationHash,
        reserveUsd,
        supply,
        coverageBps,
        uint256(123),
        breaker
      );

      receiver.onReport("", callData);
    }

    {
      uint256 reserveUsd = 1_200_000;
      uint256 supply = 1_000_000;
      uint256 coverageBps = (reserveUsd * 10000) / supply;
      bool breaker = coverageBps < 10000;
      bytes32 attestationHash = keccak256(abi.encode(reserveUsd, supply, coverageBps, uint256(124), breaker));
      bytes memory callData = abi.encodeWithSelector(
        receiver.updateAttestation.selector,
        attestationHash,
        reserveUsd,
        supply,
        coverageBps,
        uint256(124),
        breaker
      );

      receiver.onReport("", callData);
    }

    assert(!receiver.mintingPaused());
    assert(token.mintingEnabled());
  }
}
