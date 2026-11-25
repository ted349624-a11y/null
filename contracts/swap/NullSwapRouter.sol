// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface INullSwapFactory {
    function pairOf(address token) external view returns (address);
}

interface INullSwapPair {
    function getReserves() external view returns (uint112, uint112, uint32);
    function wethIsToken0() external view returns (bool);
    function feeBps() external view returns (uint16);
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title NullSwapRouter — native <-> token swaps on NullSwap pairs
/// @notice The fee lives in the pair (WETH side). The router computes the largest output that the
///         pair's fee rule and constant-product check accept, so quotes equal executions exactly.
///   buy:  fee = in * f / B;  out = rT - ceil(rW * rT / (rW + in - fee))
///   sell: gross = rW - ceil(rW * rT / (rT + in));  out = largest w with w + ceil(w * f / (B - f)) <= gross
contract NullSwapRouter {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    address public immutable factory;
    address public immutable weth;

    error Expired();
    error NoPair();
    error Slippage();
    error ZeroAmount();
    error TransferFailed();
    error OnlyWeth();

    constructor(address factory_, address weth_) {
        factory = factory_;
        weth = weth_;
    }

    receive() external payable {
        if (msg.sender != weth) revert OnlyWeth();
    }

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ---------------- quotes ----------------

    function quoteBuy(address token, uint256 nativeIn) public view returns (uint256 tokensOut) {
        (, uint256 rT, uint256 rW, , uint256 f) = _pair(token);
        tokensOut = getAmountOutBuy(nativeIn, rT, rW, f);
    }

    function quoteSell(address token, uint256 tokensIn) public view returns (uint256 nativeOut) {
        (, uint256 rT, uint256 rW, , uint256 f) = _pair(token);
        nativeOut = getAmountOutSell(tokensIn, rT, rW, f);
    }

    function getAmountOutBuy(uint256 nativeIn, uint256 rT, uint256 rW, uint256 f) public pure returns (uint256) {
        if (nativeIn == 0 || rT == 0 || rW == 0) return 0;
        uint256 net = nativeIn - nativeIn * f / BPS;
        uint256 newT = _ceilDiv(rW * rT, rW + net);
        return rT - newT;
    }

    function getAmountOutSell(uint256 tokensIn, uint256 rT, uint256 rW, uint256 f) public pure returns (uint256 w) {
        if (tokensIn == 0 || rT == 0 || rW == 0) return 0;
        uint256 gross = rW - _ceilDiv(rW * rT, rT + tokensIn);
        w = gross * (BPS - f) / BPS;
        while (w > 0 && w + _ceilDiv(w * f, BPS - f) > gross) w--;
    }

    // ---------------- swaps ----------------

    function swapExactETHForTokens(address token, uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        ensure(deadline)
        returns (uint256 out)
    {
        if (msg.value == 0) revert ZeroAmount();
        (address pair, uint256 rT, uint256 rW, bool wIs0, uint256 f) = _pair(token);
        out = getAmountOutBuy(msg.value, rT, rW, f);
        if (out == 0 || out < minTokensOut) revert Slippage();
        IWETH9(weth).deposit{value: msg.value}();
        IERC20(weth).safeTransfer(pair, msg.value);
        (uint256 o0, uint256 o1) = wIs0 ? (uint256(0), out) : (out, uint256(0));
        INullSwapPair(pair).swap(o0, o1, to);
    }

    function swapExactTokensForETH(address token, uint256 tokensIn, uint256 minNativeOut, address to, uint256 deadline)
        external
        ensure(deadline)
        returns (uint256 out)
    {
        if (tokensIn == 0) revert ZeroAmount();
        (address pair, uint256 rT, uint256 rW, bool wIs0, uint256 f) = _pair(token);
        out = getAmountOutSell(tokensIn, rT, rW, f);
        if (out == 0 || out < minNativeOut) revert Slippage();
        IERC20(token).safeTransferFrom(msg.sender, pair, tokensIn);
        (uint256 o0, uint256 o1) = wIs0 ? (out, uint256(0)) : (uint256(0), out);
        INullSwapPair(pair).swap(o0, o1, address(this));
        IWETH9(weth).withdraw(out);
        (bool ok,) = to.call{value: out}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------- internal ----------------

    function _pair(address token) internal view returns (address pair, uint256 rT, uint256 rW, bool wIs0, uint256 f) {
        pair = INullSwapFactory(factory).pairOf(token);
        if (pair == address(0)) revert NoPair();
        (uint112 r0, uint112 r1,) = INullSwapPair(pair).getReserves();
        wIs0 = INullSwapPair(pair).wethIsToken0();
        (rW, rT) = wIs0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        f = INullSwapPair(pair).feeBps();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
