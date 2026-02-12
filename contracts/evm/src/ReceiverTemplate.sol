// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC165} from "./IERC165.sol";
import {IReceiver} from "./IReceiver.sol";
import {Ownable} from "./Ownable.sol";

/// @title ReceiverTemplate - Abstract receiver with optional permission controls
/// @notice Provides flexible, updatable security checks for receiving workflow reports
/// @dev The forwarder address is required at construction time for security.
abstract contract ReceiverTemplate is IReceiver, Ownable {
  address private s_forwarderAddress;

  error InvalidForwarderAddress();
  error InvalidSender(address sender, address expected);

  event ForwarderAddressUpdated(address indexed previousForwarder, address indexed newForwarder);
  event SecurityWarning(string message);

  constructor(address forwarderAddress) Ownable(msg.sender) {
    if (forwarderAddress == address(0)) revert InvalidForwarderAddress();
    s_forwarderAddress = forwarderAddress;
    emit ForwarderAddressUpdated(address(0), forwarderAddress);
  }

  function getForwarderAddress() external view returns (address) {
    return s_forwarderAddress;
  }

  function setForwarderAddress(address forwarder) external onlyOwner {
    address previousForwarder = s_forwarderAddress;
    if (forwarder == address(0)) {
      emit SecurityWarning("Forwarder address set to zero - contract is now INSECURE");
    }
    s_forwarderAddress = forwarder;
    emit ForwarderAddressUpdated(previousForwarder, forwarder);
  }

  function onReport(bytes calldata, bytes calldata report) external override {
    if (s_forwarderAddress != address(0) && msg.sender != s_forwarderAddress) {
      revert InvalidSender(msg.sender, s_forwarderAddress);
    }

    _processReport(report);
  }

  function _processReport(bytes calldata report) internal virtual;

  function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
    return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
  }
}
