// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "./Ownable.sol";

contract LiabilityToken is Ownable {
  error MintingDisabled();
  error NotGuardian(address sender);

  event GuardianUpdated(address indexed previousGuardian, address indexed newGuardian);
  event MintingEnabledUpdated(bool mintingEnabled);
  event Minted(address indexed to, uint256 amount);

  uint256 public totalSupply;
  bool public mintingEnabled;
  address public guardian;

  mapping(address => uint256) public balanceOf;

  constructor() Ownable(msg.sender) {
    mintingEnabled = true;
  }

  function setGuardian(address newGuardian) external onlyOwner {
    address previousGuardian = guardian;
    guardian = newGuardian;
    emit GuardianUpdated(previousGuardian, newGuardian);
  }

  function setMintingEnabled(bool enabled) external {
    if (msg.sender != guardian && msg.sender != owner()) revert NotGuardian(msg.sender);
    mintingEnabled = enabled;
    emit MintingEnabledUpdated(enabled);
  }

  function mint(address to, uint256 amount) external onlyOwner {
    if (!mintingEnabled) revert MintingDisabled();

    totalSupply += amount;
    balanceOf[to] += amount;

    emit Minted(to, amount);
  }
}
