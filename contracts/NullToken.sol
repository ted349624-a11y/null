// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IUniswapV2FactoryLite {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

/// @title NullToken
/// @notice Fixed-supply ERC20. The whole supply is minted once to the launchpad at creation.
///         No owner, no mint, no blacklist, no transfer tax.
///
///         One guard until graduation: nobody but the launchpad can send this token into its
///         Uniswap V2 pair. This stops anyone from seeding the pool at a manipulated price
///         before the curve migrates its liquidity there. After graduation the token is a
///         plain ERC20 forever.
contract NullToken is ERC20 {
    address public immutable launchpad;
    address public immutable creator;
    address public immutable uniswapFactory;
    address public immutable weth;
    bool public graduated;

    error PoolLockedUntilGraduation();
    error OnlyLaunchpad();

    constructor(string memory name_, string memory symbol_, address creator_, uint256 supply, address uniswapFactory_, address weth_)
        ERC20(name_, symbol_)
    {
        launchpad = msg.sender;
        creator = creator_;
        uniswapFactory = uniswapFactory_;
        weth = weth_;
        _mint(msg.sender, supply);
    }

    function markGraduated() external {
        if (msg.sender != launchpad) revert OnlyLaunchpad();
        graduated = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (!graduated && from != launchpad && to != address(0)) {
            address pair = IUniswapV2FactoryLite(uniswapFactory).getPair(address(this), weth);
            if (pair != address(0) && to == pair) revert PoolLockedUntilGraduation();
        }
        super._update(from, to, value);
    }
}
