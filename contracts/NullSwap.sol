// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface INullLaunchpad {
    function platformFeeRecipient() external view returns (address);
    function feeWalletOf(address token) external view returns (address);
}

/// @title NullSwap
/// @notice Native/token constant-product pools for graduated launches.
///         - Pools are created only by the launchpad.
///         - Liquidity is permanently locked: there is no remove-liquidity function.
///         - Same fee as the curve: 1% (30% platform / 70% creator) + the token's creator tax.
///           The pool itself charges no LP fee.
contract NullSwap is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;
    uint256 public constant TRADE_FEE_BPS = 100; // 1%
    uint256 public constant PLATFORM_SHARE_BPS = 3_000; // 30% of fees

    struct Pool {
        uint256 reserveNative;
        uint256 reserveToken;
        uint16 creatorTaxBps;
        bool exists;
    }

    INullLaunchpad public immutable launchpad;
    uint256 public platformFeesAccrued;
    mapping(address => uint256) public creatorFeesAccrued; // token => native
    mapping(address => Pool) public pools;

    event PoolCreated(address indexed token, uint256 nativeAmount, uint256 tokenAmount);
    event Swap(address indexed token, address indexed trader, bool isBuy, uint256 nativeAmount, uint256 tokenAmount, uint256 reserveNative, uint256 reserveToken);
    event CreatorFeesClaimed(address indexed token, address indexed to, uint256 amount);

    error NotLaunchpad();
    error PoolExists();
    error NoPool();
    error Slippage();
    error ZeroAmount();
    error Expired();
    error TransferFailed();

    constructor() {
        launchpad = INullLaunchpad(msg.sender);
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    /// @dev The launchpad transfers `tokenAmount` to this contract before calling.
    function createPool(address token, uint256 tokenAmount, uint16 creatorTaxBps) external payable {
        if (msg.sender != address(launchpad)) revert NotLaunchpad();
        if (pools[token].exists) revert PoolExists();
        if (msg.value == 0 || tokenAmount == 0) revert ZeroAmount();
        pools[token] = Pool(msg.value, tokenAmount, creatorTaxBps, true);
        emit PoolCreated(token, msg.value, tokenAmount);
    }

    // ---------------- quotes ----------------

    function _feeBps(Pool memory p) internal pure returns (uint256) {
        return TRADE_FEE_BPS + p.creatorTaxBps;
    }

    function _split(uint256 fee, uint256 feeBps) internal pure returns (uint256 platform, uint256 creator) {
        platform = fee * TRADE_FEE_BPS * PLATFORM_SHARE_BPS / (feeBps * BPS);
        creator = fee - platform;
    }

    function quoteBuy(address token, uint256 nativeIn) public view returns (uint256 tokensOut, uint256 fee) {
        Pool memory p = pools[token];
        if (!p.exists) revert NoPool();
        fee = nativeIn * _feeBps(p) / BPS;
        uint256 net = nativeIn - fee;
        tokensOut = p.reserveToken * net / (p.reserveNative + net);
    }

    function quoteSell(address token, uint256 tokensIn) public view returns (uint256 nativeOut, uint256 fee) {
        Pool memory p = pools[token];
        if (!p.exists) revert NoPool();
        uint256 gross = p.reserveNative * tokensIn / (p.reserveToken + tokensIn);
        fee = gross * _feeBps(p) / BPS;
        nativeOut = gross - fee;
    }

    // ---------------- trading ----------------

    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable nonReentrant checkDeadline(deadline) {
        if (msg.value == 0) revert ZeroAmount();
        (uint256 out, uint256 fee) = quoteBuy(token, msg.value);
        if (out == 0 || out < minTokensOut) revert Slippage();
        Pool storage p = pools[token];
        p.reserveNative += msg.value - fee;
        p.reserveToken -= out;
        _accrue(token, fee, _feeBps(p));
        IERC20(token).safeTransfer(msg.sender, out);
        emit Swap(token, msg.sender, true, msg.value, out, p.reserveNative, p.reserveToken);
    }

    function sell(address token, uint256 tokensIn, uint256 minNativeOut, uint256 deadline) external nonReentrant checkDeadline(deadline) {
        if (tokensIn == 0) revert ZeroAmount();
        (uint256 out, uint256 fee) = quoteSell(token, tokensIn);
        if (out == 0 || out < minNativeOut) revert Slippage();
        Pool storage p = pools[token];
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokensIn);
        p.reserveToken += tokensIn;
        p.reserveNative -= out + fee;
        _accrue(token, fee, _feeBps(p));
        _send(msg.sender, out);
        emit Swap(token, msg.sender, false, out, tokensIn, p.reserveNative, p.reserveToken);
    }

    function _accrue(address token, uint256 fee, uint256 feeBps) internal {
        (uint256 platform, uint256 creator) = _split(fee, feeBps);
        platformFeesAccrued += platform;
        creatorFeesAccrued[token] += creator;
    }

    // ---------------- fees ----------------

    /// @notice Anyone can trigger; funds always go to the token's creator fee wallet.
    function claimCreatorFees(address token) external nonReentrant {
        uint256 amt = creatorFeesAccrued[token];
        creatorFeesAccrued[token] = 0;
        address to = launchpad.feeWalletOf(token);
        _send(to, amt);
        emit CreatorFeesClaimed(token, to, amt);
    }

    function withdrawPlatformFees() external nonReentrant {
        uint256 amt = platformFeesAccrued;
        platformFeesAccrued = 0;
        _send(launchpad.platformFeeRecipient(), amt);
    }

    function _send(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }
}
