// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title NullToken2
/// @notice Plain fixed-supply ERC20 (1,000,000,000e18 minted once to the launchpad).
///         No owner, no mint, no burn hooks, no transfer restrictions, no tax.
contract NullToken2 is ERC20 {
    address public immutable launchpad;
    address public immutable creator;

    constructor(string memory name_, string memory symbol_, address creator_, uint256 supply) ERC20(name_, symbol_) {
        launchpad = msg.sender;
        creator = creator_;
        _mint(msg.sender, supply);
    }
}
