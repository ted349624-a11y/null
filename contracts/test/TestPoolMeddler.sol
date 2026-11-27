// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @dev Test only: plays someone who initializes a collection's pool early and parks ETH-only liquidity in it.
contract TestPoolMeddler is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function initialize(PoolKey calldata key, uint160 sqrtPriceX96) external {
        pm.initialize(key, sqrtPriceX96);
    }

    function addLiquidity(PoolKey calldata key, int24 tickLower, int24 tickUpper, int256 liquidity) external payable {
        pm.unlock(abi.encode(key, tickLower, tickUpper, liquidity));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        (PoolKey memory key, int24 lo, int24 hi, int256 liq) = abi.decode(data, (PoolKey, int24, int24, int256));
        (BalanceDelta d,) = pm.modifyLiquidity(key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: liq, salt: bytes32(0)}), "");
        int128 a0 = d.amount0();
        require(d.amount1() == 0, "would need coins");
        if (a0 < 0) pm.settle{value: uint256(uint128(-a0))}();
        return "";
    }

    receive() external payable {}
}
