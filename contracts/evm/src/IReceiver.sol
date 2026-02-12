// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "./IERC165.sol";

/// @notice Receives keystone reports.
/// @dev Implementations must support the IReceiver interface through ERC165.
interface IReceiver is IERC165 {
  function onReport(bytes calldata metadata, bytes calldata report) external;
}
