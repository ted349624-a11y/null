// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {NullToken} from "./NullToken.sol";

interface IUniswapV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address);
    function createPair(address tokenA, address tokenB) external returns (address);
}

interface IUniswapV2Pair {
    function mint(address to) external returns (uint256 liquidity);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function token0() external view returns (address);
}

interface IWETH {
    function deposit() external payable;
}

/// @title NullLaunchpad
/// @notice Permissionless token launchpad with per-token bonding curves that graduate to Uniswap V2.
///
///  Supply (1,000,000,000 per token, all minted to the launchpad):
///   - 71.4% sold on a constant-product curve over virtual reserves
///   - ~20.4% + all raised native (as WETH) seed a Uniswap V2 pool at the curve's final price.
///     The LP tokens are sent to 0x…dEaD: the liquidity is locked forever.
///   - the rest (~8.2%) is locked forever at graduation (sent to 0x…dEaD)
///
///  Fees on the curve:
///   - 1% trade fee on every buy and sell (30% platform / 70% creator)
///   - optional creator tax, fixed at launch (trade fee + creator tax <= 10%)
///   - opening tax: buy-only anti-snipe tax that decays linearly to 0
///     (the creator's opening buy in the launch transaction is exempt)
///  After graduation the token trades on Uniswap V2 like any other token (0.3% LP fee, which
///  accrues to the locked liquidity).
///
///  The owner can change the virtual reserve (graduation size), launch fee and migration fee for
///  FUTURE launches only. Existing launches keep the parameters they started with.
contract NullLaunchpad is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    // ---------------- constants ----------------
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;
    uint256 public constant CURVE_SUPPLY = 714_000_000e18; // 71.4%
    uint256 public constant VIRTUAL_TOKEN_RESERVE = 1_000_000_000e18;

    uint256 public constant BPS = 10_000;
    uint256 public constant TRADE_FEE_BPS = 100; // 1%
    uint256 public constant PLATFORM_SHARE_BPS = 3_000; // 30% of fees
    uint256 public constant MAX_TOTAL_FEE_BPS = 1_000; // trade fee + creator tax <= 10%
    uint256 public constant MAX_CREATOR_TAX_BPS = MAX_TOTAL_FEE_BPS - TRADE_FEE_BPS; // 9%

    address public constant LOCK_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ---------------- config ----------------
    IUniswapV2Factory public immutable uniswapFactory;
    address public immutable weth;
    uint256 public immutable openingTaxStartBps; // e.g. 8000 = 80% at t=0
    uint256 public immutable openingTaxDuration; // seconds until the opening tax reaches 0

    uint256 public virtualNativeReserve; // for new launches; 1.68 => graduates at ~4.19 native
    address public platformFeeRecipient;
    uint256 public launchFee; // native, paid on createToken
    uint256 public migrationFee; // native, taken from the curve at graduation (capped at 10% of it)
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

    struct LaunchView {
        address token;
        string name;
        string symbol;
        Launch launch;
        Metadata meta;
        address pair; // Uniswap V2 pair once graduated
        uint256 price; // native wei per 1 whole token
        uint256 progressBps;
        uint256 openingTaxBps; // current
        uint256 graduationTarget; // native the curve must raise
        uint256 creatorFeesAccrued;
    }

    mapping(address => Launch) public launches;
    mapping(address => Metadata) internal _meta;
    mapping(address => uint256) public creatorFeesAccrued; // token => native
    mapping(address => address) public pairOf; // token => Uniswap V2 pair (set at graduation)
    address[] public allTokens;

    // ---------------- events ----------------
    event TokenLaunched(address indexed token, address indexed creator, string name, string symbol, uint16 creatorTaxBps);
    event Trade(address indexed token, address indexed trader, bool isBuy, uint256 nativeAmount, uint256 tokenAmount, uint256 fee, uint256 virtualNative, uint256 virtualToken);
    event Graduated(address indexed token, address indexed pair, uint256 nativeToPool, uint256 tokensToPool, uint256 tokensLocked, uint256 liquidity);
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

    constructor(
        address uniswapFactory_,
        address weth_,
        uint256 virtualNativeReserve_,
        uint256 openingTaxStartBps_,
        uint256 openingTaxDuration_,
        uint256 launchFee_,
        uint256 migrationFee_,
        address platformFeeRecipient_
    ) Ownable(msg.sender) {
        if (uniswapFactory_ == address(0) || weth_ == address(0)) revert BadParams();
        if (virtualNativeReserve_ == 0 || platformFeeRecipient_ == address(0)) revert BadParams();
        if (openingTaxStartBps_ + MAX_TOTAL_FEE_BPS >= BPS) revert BadParams();
        uniswapFactory = IUniswapV2Factory(uniswapFactory_);
        weth = weth_;
        virtualNativeReserve = virtualNativeReserve_;
        openingTaxStartBps = openingTaxStartBps_;
        openingTaxDuration = openingTaxDuration_;
        launchFee = launchFee_;
        migrationFee = migrationFee_;
        platformFeeRecipient = platformFeeRecipient_;
    }

    modifier checkDeadline(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // =====================================================================
    // Launch
    // =====================================================================

    /// @notice Launch a token in one transaction.
    ///         msg.value = launchFee + optional opening buy (opening tax exempt).
    /// @param feeWallet receives creator earnings (0 = msg.sender). Can be changed later by the creator.
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

        token = address(new NullToken(name, symbol, msg.sender, TOTAL_SUPPLY, address(uniswapFactory), weth));
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
        platformFeesAccrued += launchFee;
        emit TokenLaunched(token, msg.sender, name, symbol, creatorTaxBps);

        uint256 openingBuy = msg.value - launchFee;
        if (openingBuy > 0) _buy(token, openingBuy, minTokensOut, false);
    }

    /// @notice The creator may redirect future earnings. Everything else is fixed at launch.
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
            // Final buy: fill only what is left, charge only for that, refund the rest.
            tokensOut = l.realToken;
            netIn = _ceilDiv(l.virtualNative * tokensOut, l.virtualToken - tokensOut);
            uint256 grossNeeded = _ceilDiv(netIn * BPS, BPS - feeBps);
            if (grossNeeded > value) grossNeeded = value; // rounding guard
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

    /// @dev Splits `fee` charged at `feeBps`. The platform takes 30% of the part that comes from
    ///      `sharedBps` (trade fee + opening tax); the creator gets the rest including all creator tax.
    function _accrue(address token, uint256 fee, uint256 feeBps, uint256 sharedBps) internal {
        uint256 platform = fee * sharedBps * PLATFORM_SHARE_BPS / (feeBps * BPS);
        platformFeesAccrued += platform;
        creatorFeesAccrued[token] += fee - platform;
    }

    // =====================================================================
    // Graduation -> Uniswap V2
    // =====================================================================

    function _graduate(address token, Launch storage l) internal {
        l.graduated = true;
        NullToken(token).markGraduated();

        uint256 nativeAmt = l.realNative;
        uint256 maxFee = nativeAmt / 10;
        uint256 mFee = migrationFee > maxFee ? maxFee : migrationFee;
        nativeAmt -= mFee;
        platformFeesAccrued += mFee;
        l.realNative = 0;

        // Seed the pool at the curve's final price so the price is continuous.
        uint256 available = IERC20(token).balanceOf(address(this));
        uint256 tokensToPool = nativeAmt * l.virtualToken / l.virtualNative;
        if (tokensToPool > available) tokensToPool = available;
        uint256 locked = available - tokensToPool;

        address pair = uniswapFactory.getPair(token, weth);
        if (pair == address(0)) pair = uniswapFactory.createPair(token, weth);
        pairOf[token] = pair;

        // Fund the pair directly and mint, instead of going through the router: any WETH someone
        // donated to the pair beforehand simply becomes part of the locked liquidity. Nobody can have
        // put tokens into the pair (NullToken blocks that until graduation), so this cannot be griefed.
        IWETH(weth).deposit{value: nativeAmt}();
        IERC20(weth).safeTransfer(pair, nativeAmt);
        IERC20(token).safeTransfer(pair, tokensToPool);
        uint256 liquidity = IUniswapV2Pair(pair).mint(LOCK_ADDRESS); // LP tokens burned: liquidity locked forever

        if (locked > 0) IERC20(token).safeTransfer(LOCK_ADDRESS, locked);
        emit Graduated(token, pair, nativeAmt, tokensToPool, locked, liquidity);
    }

    // =====================================================================
    // Fees & admin
    // =====================================================================

    /// @notice Anyone can trigger; funds always go to the token's fee wallet.
    function claimCreatorFees(address token) external nonReentrant {
        uint256 amt = creatorFeesAccrued[token];
        creatorFeesAccrued[token] = 0;
        address to = launches[token].feeWallet;
        _send(to, amt);
        emit CreatorFeesClaimed(token, to, amt);
    }

    /// @notice Anyone can trigger; funds always go to the platform fee recipient.
    function withdrawPlatformFees() external nonReentrant {
        uint256 amt = platformFeesAccrued;
        platformFeesAccrued = 0;
        _send(platformFeeRecipient, amt);
    }

    function setPlatformFeeRecipient(address r) external onlyOwner {
        if (r == address(0)) revert BadParams();
        platformFeeRecipient = r;
    }

    /// @notice Applies to launches created after this call only.
    function setVirtualNativeReserve(uint256 v) external onlyOwner {
        if (v == 0) revert BadParams();
        virtualNativeReserve = v;
        emit ParamsChanged(virtualNativeReserve, launchFee, migrationFee);
    }

    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit ParamsChanged(virtualNativeReserve, launchFee, migrationFee);
    }

    /// @notice Capped at 10% of the raised amount at graduation time.
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

    /// @notice Native the curve must raise (excluding fees) for a given starting virtual reserve.
    function _target(uint256 v) internal pure returns (uint256) {
        return v * VIRTUAL_TOKEN_RESERVE / (VIRTUAL_TOKEN_RESERVE - CURVE_SUPPLY) - v;
    }

    /// @notice Graduation target for NEW launches.
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

    /// @notice Native wei per 1 whole token: curve price, or Uniswap pool price once graduated.
    function priceOf(address token) public view returns (uint256) {
        Launch memory l = launches[token];
        if (l.creator == address(0)) return 0;
        if (l.graduated) {
            IUniswapV2Pair pair = IUniswapV2Pair(pairOf[token]);
            (uint112 r0, uint112 r1,) = pair.getReserves();
            (uint256 rToken, uint256 rNative) = pair.token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
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
        v.name = NullToken(token).name();
        v.symbol = NullToken(token).symbol();
        v.launch = l;
        v.meta = _meta[token];
        v.pair = pairOf[token];
        v.price = priceOf(token);
        v.progressBps = progressBps(token);
        v.openingTaxBps = _openingTaxBps(l);
        v.graduationTarget = _target(l.initialVirtualNative);
        v.creatorFeesAccrued = creatorFeesAccrued[token];
    }

    /// @notice Newest first.
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
