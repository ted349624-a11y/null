// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NullToken2} from "./NullToken2.sol";
import {NullSwapFactory} from "./swap/NullSwapFactory.sol";

interface INullSwapPairLike {
    function mint(address to) external returns (uint256 liquidity);
    function skim(address to) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function wethIsToken0() external view returns (bool);
}

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title NullLaunchpad2 — bonding curves that graduate into null's own AMM (NullSwap)
/// @notice
///  Supply (1,000,000,000 per token, all minted to the launchpad):
///   - 71.4% sold on a constant-product curve over virtual reserves
///   - ~20.4% + all raised native (as WETH) seed a NullSwap pair at the curve's final price; the LP
///     tokens go to 0x…dEaD, so the liquidity is locked forever
///   - the rest (~8.2%) is locked forever at graduation (sent to 0x…dEaD)
///
///  Fees — the same before AND after graduation:
///   - 1% trade fee on every buy and sell (30% platform / 70% creator)
///   - optional creator tax, fixed at launch (trade fee + creator tax <= 10%), 100% to the creator
///   - opening tax: buy-only anti-snipe tax on the curve that decays linearly to 0
///     (the creator's opening buy in the launch transaction is exempt)
///  On NullSwap the pair sends the fee (in WETH) to this contract, which unwraps and splits it.
///
///  The owner can change the virtual reserve (graduation size), launch fee and migration fee for
///  FUTURE launches only. Existing launches keep the parameters they started with.
contract NullLaunchpad2 is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ---------------- constants ----------------
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 714_000_000e18; // 71.4%
    uint256 public constant VIRTUAL_TOKEN_RESERVE = 1_000_000_000e18;

    uint256 public constant BPS = 10_000;
    uint256 public constant TRADE_FEE_BPS = 100; // 1%
    uint256 public constant PLATFORM_SHARE_BPS = 3_000; // 30% of the trade fee
    uint256 public constant MAX_TOTAL_FEE_BPS = 1_000; // trade fee + creator tax <= 10%
    uint256 public constant MAX_CREATOR_TAX_BPS = MAX_TOTAL_FEE_BPS - TRADE_FEE_BPS; // 9%

    address public constant LOCK_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ---------------- config ----------------
    NullSwapFactory public immutable swapFactory;
    address public immutable weth;
    uint256 public immutable openingTaxStartBps;
    uint256 public immutable openingTaxDuration;

    uint256 public virtualNativeReserve; // for new launches
    address public platformFeeRecipient;
    uint256 public launchFee;
    uint256 public migrationFee; // capped at 10% of the raise at graduation
    uint256 public platformFeesAccrued;

    // ---------------- state ----------------
    struct Launch {
        address creator;
        address feeWallet;
        uint16 creatorTaxBps;
        uint64 createdAt;
        bool graduated;
        uint256 initialVirtualNative;
        uint256 virtualNative;
        uint256 virtualToken;
        uint256 realNative;
        uint256 realToken;
    }

    struct Metadata {
        string image;
        string description;
        string website;
        string twitter;
        string telegram;
    }

    struct CreatorStats {
        uint32 launches;
        uint32 graduations;
    }

    struct LaunchView {
        address token;
        string name;
        string symbol;
        Launch launch;
        Metadata meta;
        address pair;
        uint256 price; // native wei per 1 whole token
        uint256 progressBps;
        uint256 openingTaxBps;
        uint256 graduationTarget;
        uint256 creatorFeesAccrued;
        CreatorStats creatorStats;
    }

    mapping(address => Launch) public launches;
    mapping(address => Metadata) internal _meta;
    mapping(address => uint256) public creatorFeesAccrued; // token => native
    mapping(address => address) public pairOf; // token => NullSwap pair
    mapping(address => CreatorStats) public creatorStats; // creator => record
    address[] public allTokens;

    // ---------------- events ----------------
    event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint16 creatorTaxBps);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 nativeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualNative, uint256 virtualToken);
    event Graduated(address indexed token, address indexed pair, uint256 nativeToPool, uint256 tokensToPool, uint256 tokensLocked, uint256 liquidity);
    event PoolFee(address indexed token, uint256 amount, uint256 platformShare, uint256 creatorShare);
    event FeeWalletChanged(address indexed token, address wallet);
    event CreatorFeesClaimed(address indexed token, address indexed to, uint256 amount);
    event ParamsChanged(uint256 virtualNativeReserve, uint256 launchFee, uint256 migrationFee);

    // ---------------- errors ----------------
    error UnknownToken();
    error Graduated_();
    error Slippage();
    error ZeroAmount();
    error Expired();
    error TransferFailed();
    error BadParams();
    error NotCreator();
    error InsufficientLaunchFee();
    error OnlyPair();
    error OnlyWeth();

    constructor(
        address weth_,
        uint256 virtualNativeReserve_,
        uint256 openingTaxStartBps_,
        uint256 openingTaxDuration_,
        uint256 launchFee_,
        uint256 migrationFee_,
        address platformFeeRecipient_
    ) Ownable(msg.sender) {
        if (weth_ == address(0) || virtualNativeReserve_ == 0 || platformFeeRecipient_ == address(0)) revert BadParams();
        if (openingTaxStartBps_ + MAX_TOTAL_FEE_BPS >= BPS) revert BadParams();
        weth = weth_;
        swapFactory = new NullSwapFactory(weth_);
        virtualNativeReserve = virtualNativeReserve_;
        openingTaxStartBps = openingTaxStartBps_;
        openingTaxDuration = openingTaxDuration_;
        launchFee = launchFee_;
        migrationFee = migrationFee_;
        platformFeeRecipient = platformFeeRecipient_;
    }

    /// @dev Native only arrives as payment through payable functions or from unwrapping WETH pool fees.
    receive() external payable {
        if (msg.sender != weth) revert OnlyWeth();
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // =====================================================================
    // Launch
    // =====================================================================

    function createToken(
        string calldata name,
        string calldata symbol,
        Metadata calldata meta,
        uint16 creatorTaxBps,
        address feeWallet,
        uint256 minTokensOut
    ) external payable nonReentrant returns (address token) {
        if (bytes(name).length == 0 || bytes(name).length > 32) revert BadParams();
        if (bytes(symbol).length == 0 || bytes(symbol).length > 10) revert BadParams();
        if (bytes(meta.description).length > 500 || bytes(meta.image).length > 300) revert BadParams();
        if (bytes(meta.website).length > 200 || bytes(meta.twitter).length > 200 || bytes(meta.telegram).length > 200) revert BadParams();
        if (creatorTaxBps > MAX_CREATOR_TAX_BPS) revert BadParams();
        if (msg.value < launchFee) revert InsufficientLaunchFee();

        token = address(new NullToken2(name, symbol, msg.sender, TOTAL_SUPPLY));
        launches[token] = Launch({
            creator: msg.sender,
            feeWallet: feeWallet == address(0) ? msg.sender : feeWallet,
            creatorTaxBps: creatorTaxBps,
            createdAt: uint64(block.timestamp),
            graduated: false,
            initialVirtualNative: virtualNativeReserve,
            virtualNative: virtualNativeReserve,
            virtualToken: VIRTUAL_TOKEN_RESERVE,
            realNative: 0,
            realToken: CURVE_SUPPLY
        });
        _meta[token] = meta;
        allTokens.push(token);
        creatorStats[msg.sender].launches += 1;
        platformFeesAccrued += launchFee;
        emit TokenLaunched(token, msg.sender, name, symbol, creatorTaxBps);

        uint256 openingBuy = msg.value - launchFee;
        if (openingBuy > 0) _buy(token, openingBuy, minTokensOut, false);
    }

    function setFeeWallet(address token, address wallet) external {
        Launch storage l = launches[token];
        if (l.creator != msg.sender) revert NotCreator();
        if (wallet == address(0)) revert BadParams();
        l.feeWallet = wallet;
        emit FeeWalletChanged(token, wallet);
    }

    // =====================================================================
    // Trade (bonding curve)
    // =====================================================================

    function buy(address token, uint256 minTokensOut, uint256 deadline) external payable nonReentrant checkDeadline(deadline) {
        _buy(token, msg.value, minTokensOut, true);
    }

    function sell(address token, uint256 tokenAmount, uint256 minNativeOut, uint256 deadline)
        external
        nonReentrant
        checkDeadline(deadline)
    {
        Launch storage l = _active(token);
        if (tokenAmount == 0) revert ZeroAmount();

        uint256 gross = l.virtualNative * tokenAmount / (l.virtualToken + tokenAmount);
        if (gross > l.realNative) gross = l.realNative;
        uint256 feeBps = TRADE_FEE_BPS + l.creatorTaxBps;
        uint256 fee = gross * feeBps / BPS;
        uint256 out = gross - fee;
        if (out == 0 || out < minNativeOut) revert Slippage();

        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        l.virtualNative -= gross;
        l.virtualToken += tokenAmount;
        l.realNative -= gross;
        l.realToken += tokenAmount;
        _accrue(token, fee, feeBps, TRADE_FEE_BPS);

        _send(msg.sender, out);
        emit Trade(token, msg.sender, false, out, tokenAmount, fee, l.virtualNative, l.virtualToken);
    }

    function _buy(address token, uint256 value, uint256 minTokensOut, bool applyOpeningTax) internal {
        Launch storage l = _active(token);
        if (value == 0) revert ZeroAmount();

        uint256 openBps = applyOpeningTax ? _openingTaxBps(l) : 0;
        uint256 feeBps = TRADE_FEE_BPS + l.creatorTaxBps + openBps;

        uint256 fee = value * feeBps / BPS;
        uint256 netIn = value - fee;
        uint256 tokensOut = l.virtualToken * netIn / (l.virtualNative + netIn);
        uint256 refund;

        if (tokensOut >= l.realToken) {
            tokensOut = l.realToken;
            netIn = _ceilDiv(l.virtualNative * tokensOut, l.virtualToken - tokensOut);
            uint256 grossNeeded = _ceilDiv(netIn * BPS, BPS - feeBps);
            if (grossNeeded > value) grossNeeded = value;
            fee = grossNeeded - netIn;
            refund = value - grossNeeded;
        }
        if (tokensOut == 0 || tokensOut < minTokensOut) revert Slippage();

        l.virtualNative += netIn;
        l.virtualToken -= tokensOut;
        l.realNative += netIn;
        l.realToken -= tokensOut;
        _accrue(token, fee, feeBps, TRADE_FEE_BPS + openBps);

        IERC20(token).safeTransfer(msg.sender, tokensOut);
        emit Trade(token, msg.sender, true, netIn, tokensOut, fee, l.virtualNative, l.virtualToken);

        if (l.realToken == 0) _graduate(token, l);
        if (refund > 0) _send(msg.sender, refund);
    }

    /// @dev The platform takes 30% of the part of `fee` that comes from `sharedBps` (trade fee +
    ///      opening tax); the creator gets the rest, including all creator tax.
    function _accrue(address token, uint256 fee, uint256 feeBps, uint256 sharedBps) internal returns (uint256 platform) {
        platform = fee * sharedBps * PLATFORM_SHARE_BPS / (feeBps * BPS);
        platformFeesAccrued += platform;
        creatorFeesAccrued[token] += fee - platform;
    }

    // =====================================================================
    // Graduation -> NullSwap
    // =====================================================================

    function _graduate(address token, Launch storage l) internal {
        l.graduated = true;
        creatorStats[l.creator].graduations += 1;

        uint256 nativeAmt = l.realNative;
        uint256 maxFee = nativeAmt / 10;
        uint256 mFee = migrationFee > maxFee ? maxFee : migrationFee;
        nativeAmt -= mFee;
        platformFeesAccrued += mFee;
        l.realNative = 0;

        uint256 available = IERC20(token).balanceOf(address(this));
        uint256 tokensToPool = nativeAmt * l.virtualToken / l.virtualNative;
        if (tokensToPool > available) tokensToPool = available;
        uint256 locked = available - tokensToPool;

        address pair = swapFactory.createPair(token, uint16(TRADE_FEE_BPS + l.creatorTaxBps));
        pairOf[token] = pair;
        // Anything sent to the (predictable) pair address before it existed is burned, not counted.
        INullSwapPairLike(pair).skim(LOCK_ADDRESS);
        IWETH(weth).deposit{value: nativeAmt}();
        IERC20(weth).safeTransfer(pair, nativeAmt);
        IERC20(token).safeTransfer(pair, tokensToPool);
        uint256 liquidity = INullSwapPairLike(pair).mint(LOCK_ADDRESS); // LP locked forever

        if (locked > 0) IERC20(token).safeTransfer(LOCK_ADDRESS, locked);
        emit Graduated(token, pair, nativeAmt, tokensToPool, locked, liquidity);
    }

    /// @notice Called by a NullSwap pair after it sent `amount` WETH of swap fees to this contract.
    function onPoolFee(address token, uint256 amount) external {
        address pair = pairOf[token];
        if (pair == address(0) || msg.sender != pair) revert OnlyPair();
        if (amount == 0) return;
        IWETH(weth).withdraw(amount);
        uint256 platform = _accrue(token, amount, TRADE_FEE_BPS + launches[token].creatorTaxBps, TRADE_FEE_BPS);
        emit PoolFee(token, amount, platform, amount - platform);
    }

    // =====================================================================
    // Fees & admin
    // =====================================================================

    function claimCreatorFees(address token) external nonReentrant {
        uint256 amt = creatorFeesAccrued[token];
        creatorFeesAccrued[token] = 0;
        address to = launches[token].feeWallet;
        _send(to, amt);
        emit CreatorFeesClaimed(token, to, amt);
    }

    function withdrawPlatformFees() external nonReentrant {
        uint256 amt = platformFeesAccrued;
        platformFeesAccrued = 0;
        _send(platformFeeRecipient, amt);
    }

    function setPlatformFeeRecipient(address r) external onlyOwner {
        if (r == address(0)) revert BadParams();
        platformFeeRecipient = r;
    }

    function setVirtualNativeReserve(uint256 v) external onlyOwner {
        if (v == 0) revert BadParams();
        virtualNativeReserve = v;
        emit ParamsChanged(virtualNativeReserve, launchFee, migrationFee);
    }

    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit ParamsChanged(virtualNativeReserve, launchFee, migrationFee);
    }

    function setMigrationFee(uint256 fee) external onlyOwner {
        migrationFee = fee;
        emit ParamsChanged(virtualNativeReserve, launchFee, migrationFee);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function feeWalletOf(address token) external view returns (address) {
        return launches[token].feeWallet;
    }

    function openingTaxBps(address token) public view returns (uint256) {
        return _openingTaxBps(launches[token]);
    }

    function _target(uint256 v) internal pure returns (uint256) {
        return v * VIRTUAL_TOKEN_RESERVE / (VIRTUAL_TOKEN_RESERVE - CURVE_SUPPLY) - v;
    }

    function graduationTarget() public view returns (uint256) {
        return _target(virtualNativeReserve);
    }

    function graduationTargetOf(address token) public view returns (uint256) {
        return _target(launches[token].initialVirtualNative);
    }

    function quoteBuy(address token, uint256 value) external view returns (uint256 tokensOut) {
        Launch memory l = launches[token];
        if (l.creator == address(0) || l.graduated) return 0;
        uint256 feeBps = TRADE_FEE_BPS + l.creatorTaxBps + _openingTaxBps(l);
        uint256 netIn = value - value * feeBps / BPS;
        tokensOut = l.virtualToken * netIn / (l.virtualNative + netIn);
        if (tokensOut > l.realToken) tokensOut = l.realToken;
    }

    function quoteSell(address token, uint256 tokenAmount) external view returns (uint256 nativeOut) {
        Launch memory l = launches[token];
        if (l.creator == address(0) || l.graduated) return 0;
        uint256 gross = l.virtualNative * tokenAmount / (l.virtualToken + tokenAmount);
        if (gross > l.realNative) gross = l.realNative;
        nativeOut = gross - gross * (TRADE_FEE_BPS + l.creatorTaxBps) / BPS;
    }

    function priceOf(address token) public view returns (uint256) {
        Launch memory l = launches[token];
        if (l.creator == address(0)) return 0;
        if (l.graduated) {
            INullSwapPairLike pair = INullSwapPairLike(pairOf[token]);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            (uint256 rNative, uint256 rToken) = pair.wethIsToken0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            return rToken == 0 ? 0 : rNative * 1e18 / rToken;
        }
        return l.virtualNative * 1e18 / l.virtualToken;
    }

    function progressBps(address token) public view returns (uint256) {
        Launch memory l = launches[token];
        if (l.graduated) return BPS;
        return (CURVE_SUPPLY - l.realToken) * BPS / CURVE_SUPPLY;
    }

    function getMetadata(address token) external view returns (Metadata memory) {
        return _meta[token];
    }

    function tokenCount() external view returns (uint256) {
        return allTokens.length;
    }

    function getLaunch(address token) public view returns (LaunchView memory v) {
        Launch memory l = launches[token];
        if (l.creator == address(0)) revert UnknownToken();
        v.token = token;
        v.name = NullToken2(token).name();
        v.symbol = NullToken2(token).symbol();
        v.launch = l;
        v.meta = _meta[token];
        v.pair = pairOf[token];
        v.price = priceOf(token);
        v.progressBps = progressBps(token);
        v.openingTaxBps = _openingTaxBps(l);
        v.graduationTarget = _target(l.initialVirtualNative);
        v.creatorFeesAccrued = creatorFeesAccrued[token];
        v.creatorStats = creatorStats[l.creator];
    }

    function getLaunches(uint256 offset, uint256 limit) external view returns (LaunchView[] memory out) {
        uint256 n = allTokens.length;
        if (offset >= n) return new LaunchView[](0);
        uint256 end = offset + limit > n ? n : offset + limit;
        out = new LaunchView[](end - offset);
        for (uint256 i = offset; i < end; i++) out[i - offset] = getLaunch(allTokens[n - 1 - i]);
    }

    // =====================================================================
    // Internal
    // =====================================================================

    function _active(address token) internal view returns (Launch storage l) {
        l = launches[token];
        if (l.creator == address(0)) revert UnknownToken();
        if (l.graduated) revert Graduated_();
    }

    function _openingTaxBps(Launch memory l) internal view returns (uint256) {
        if (l.creator == address(0) || openingTaxDuration == 0) return 0;
        uint256 elapsed = block.timestamp - l.createdAt;
        if (elapsed >= openingTaxDuration) return 0;
        return openingTaxStartBps * (openingTaxDuration - elapsed) / openingTaxDuration;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _send(address to, uint256 amt) internal {
        if (amt == 0) return;
        (bool ok,) = to.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }
}
