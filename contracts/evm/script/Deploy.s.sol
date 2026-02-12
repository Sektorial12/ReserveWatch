// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {LiabilityToken} from "../src/LiabilityToken.sol";
import {ReserveWatchReceiver} from "../src/ReserveWatchReceiver.sol";

contract Deploy {
  address public constant MOCK_FORWARDER_SEPOLIA = 0x15fC6ae953E024d975e77382eEeC56A9101f9F88;
  uint256 public constant MIN_COVERAGE_BPS = 10000;

  function run() external returns (address token, address receiver) {
    token = address(new LiabilityToken());
    receiver = address(new ReserveWatchReceiver(MOCK_FORWARDER_SEPOLIA, token, MIN_COVERAGE_BPS));

    LiabilityToken(token).setGuardian(receiver);
  }
}
