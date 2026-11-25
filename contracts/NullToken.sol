// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title NullToken
/// @notice Fixed-supply ERC20. The whole supply is minted once to the launchpad at creation.
///         No owner, no mint, no blacklist, no transfer tax.
contract NullToken is ERC20 {
    address public immutable launchpad;
    address public immutable creator;

    constructor(string memory name_, string memory symbol_, address creator_, uint256 supply) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        creator = creator_;
        _mint(msg.sender, supply);
    }
}
