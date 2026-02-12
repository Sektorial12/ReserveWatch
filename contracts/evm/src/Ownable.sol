// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

abstract contract Ownable {
  error NotOwner(address sender);

  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

  address private s_owner;

  constructor(address initialOwner) {
    s_owner = initialOwner;
    emit OwnershipTransferred(address(0), initialOwner);
  }

  modifier onlyOwner() {
    if (msg.sender != s_owner) revert NotOwner(msg.sender);
    _;
  }

  function owner() public view returns (address) {
    return s_owner;
  }

  function transferOwnership(address newOwner) external onlyOwner {
    address previousOwner = s_owner;
    s_owner = newOwner;
    emit OwnershipTransferred(previousOwner, newOwner);
  }
}
