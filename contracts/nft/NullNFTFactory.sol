// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

import {NullNFTCollection} from "./NullNFTCollection.sol";
import {NullNFTCoin} from "./NullNFTCoin.sol";

/// @title NullNFTFactory
/// @notice Launches null_ NFT collections (each with its own coin) and is the permanent owner of their
///         Uniswap v4 liquidity: a full-range ETH/coin position in a plain 1% pool (no hook), opened at the
///         mint price when the mint ends. The position can never be removed; its trading fees are split
///         between the collection's creator and the platform.
contract NullNFTFactory is Ownable, IUnlockCallback, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;

    struct CreateParams {
        string name;
        string symbol;
        uint32 nftSupply;
        uint256 coinSupply; // whole coins; every NFT holds coinSupply / nftSupply
        uint256 mintPrice; // wei per NFT
        uint64 duration; // seconds the mint stays open
        uint32 maxPerWallet; // 0 = no limit
    }

    uint24 public constant POOL_FEE = 10_000; // 1%
    int24 public constant TICK_SPACING = 200;
    int24 public constant TICK_LOWER = -887_200; // full range for spacing 200
    int24 public constant TICK_UPPER = 887_200;
    uint8 private constant OP_OPEN = 1;
    uint8 private constant OP_COLLECT = 2;

    IPoolManager public immutable poolManager;
    address public immutable collectionImpl;
    address public immutable coinImpl;

    address public feeRecipient;
    uint256 public launchFee;
    uint16 public mintFeeBps = 500; // platform's share of mint revenue
    uint16 public lpBps = 2_500; // pool share: NFTs (and ETH) worth 25% of the mint go into the pool
    uint16 public creatorFeeBps = 5_000; // creator's share of the pool's trading fees

    address[] public collections;
    mapping(address => bool) public isCollection;
    mapping(address => address) public coinOf;
    mapping(address => uint16) public creatorFeeBpsOf; // fixed per collection at launch
    mapping(address => uint128) public liquidityOf; // our locked liquidity, per collection
    mapping(address => uint256) public owed; // payouts that could not be pushed

    event CollectionCreated(
        address indexed collection, address indexed coin, address indexed creator, string name, string symbol,
        uint256 nftSupply, uint256 coinSupply, uint256 mintPrice, uint256 mintEnd
    );
    event PoolOpened(address indexed collection, PoolId indexed poolId, uint128 liquidity, uint256 eth, uint256 coins);
    event FeesCollected(address indexed collection, uint256 eth, uint256 coins, uint256 creatorEth, uint256 creatorCoins);
    event SettingsChanged(address feeRecipient, uint256 launchFee, uint16 mintFeeBps, uint16 lpBps, uint16 creatorFeeBps);

    error WrongLaunchFee();
    error BadText();
    error BadSupply();
    error UnevenSplit();
    error BadPrice();
    error BadDuration();
    error BadWalletLimit();
    error NotCollection();
    error PoolAlreadyOpen();
    error NoPool();
    error OnlyPoolManager();
    error BadSetting();
    error NothingOwed();
    error PayFailed();

    constructor(IPoolManager poolManager_, address collectionImpl_, address coinImpl_, address owner_, address feeRecipient_, uint256 launchFee_)
        Ownable(owner_)
    {
        poolManager = poolManager_;
        collectionImpl = collectionImpl_;
        coinImpl = coinImpl_;
        feeRecipient = feeRecipient_;
        launchFee = launchFee_;
    }

    // ------------------------------------------------------------------ launch

    function createCollection(CreateParams calldata p) external payable nonReentrant returns (address collection, address coin) {
        if (msg.value != launchFee) revert WrongLaunchFee();
        _checkText(p.name, 32);
        _checkText(p.symbol, 12);
        if (p.nftSupply < 2 || p.nftSupply > 10_000 || p.coinSupply == 0 || p.coinSupply > 1e12) revert BadSupply();
        uint256 total = p.coinSupply * 1e18;
        if (total % p.nftSupply != 0) revert UnevenSplit();
        if (p.mintPrice < 1 gwei || p.mintPrice > 100 ether) revert BadPrice();
        if (p.duration < 5 minutes || p.duration > 30 days) revert BadDuration();
        if (p.maxPerWallet > p.nftSupply) revert BadWalletLimit();

        collection = Clones.clone(collectionImpl);
        coin = Clones.clone(coinImpl);
        NullNFTCoin(coin).initialize(p.name, p.symbol, collection);
        uint64 mintEnd = uint64(block.timestamp) + p.duration;
        NullNFTCollection(payable(collection)).initialize(
            msg.sender,
            coin,
            NullNFTCollection.Config({
                name: p.name,
                symbol: p.symbol,
                nftSupply: p.nftSupply,
                maxPerWallet: p.maxPerWallet,
                mintEnd: mintEnd,
                mintFeeBps: mintFeeBps,
                lpBps: lpBps,
                perNFT: total / p.nftSupply,
                mintPrice: p.mintPrice
            })
        );
        collections.push(collection);
        isCollection[collection] = true;
        coinOf[collection] = coin;
        creatorFeeBpsOf[collection] = creatorFeeBps;
        _pay(feeRecipient, msg.value);
        emit CollectionCreated(collection, coin, msg.sender, p.name, p.symbol, p.nftSupply, p.coinSupply, p.mintPrice, mintEnd);
    }

    /// @dev Printable ASCII only, without quotes, backslash and <>& (the text goes into JSON and SVG).
    function _checkText(string calldata s, uint256 maxLen) private pure {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > maxLen) revert BadText();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c < 0x20 || c > 0x7e || c == '"' || c == "\\" || c == "<" || c == ">" || c == "&") revert BadText();
        }
    }

    // ------------------------------------------------------------------ pool

    function poolKey(address coin) public pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)), // native ETH always sorts first
            currency1: Currency.wrap(coin),
            fee: POOL_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
    }

    function poolId(address coin) public pure returns (PoolId) {
        return PoolId.wrap(keccak256(abi.encode(poolKey(coin))));
    }

    /// @notice Called by a collection at finalize with the pool's ETH (msg.value) and coins (already minted here).
    ///         Unused ETH goes back to the collection; unused coin dust goes to the fee recipient (it stays backed).
    function openPool(address coin, uint256 coinAmount) external payable returns (uint256 ethLeft, uint256 coinLeft) {
        if (!isCollection[msg.sender] || coinOf[msg.sender] != coin) revert NotCollection();
        if (liquidityOf[msg.sender] != 0) revert PoolAlreadyOpen();
        uint160 target = sqrtPriceFor(msg.value, coinAmount);
        PoolKey memory key = poolKey(coin);
        (uint160 current,,,) = poolManager.getSlot0(poolId(coin));
        if (current == 0) poolManager.initialize(key, target);
        (ethLeft, coinLeft) = abi.decode(
            poolManager.unlock(abi.encode(OP_OPEN, abi.encode(msg.sender, coin, msg.value, coinAmount, target))), (uint256, uint256)
        );
        if (coinLeft > 0) IERC20(coin).safeTransfer(feeRecipient, coinLeft);
        if (ethLeft > 0) {
            (bool ok,) = msg.sender.call{value: ethLeft}("");
            if (!ok) revert PayFailed();
        }
        // ethLeft can exceed msg.value if the opening price move sold pool coins for ETH (see _open)
        emit PoolOpened(msg.sender, poolId(coin), liquidityOf[msg.sender], msg.value > ethLeft ? msg.value - ethLeft : 0, coinAmount - coinLeft);
    }

    /// @notice Claims the pool's trading fees for a collection and splits them between creator and platform.
    ///         Anyone can call it.
    function collectFees(address collection) external nonReentrant returns (uint256 eth, uint256 coins) {
        address coin = coinOf[collection];
        if (liquidityOf[collection] == 0) revert NoPool();
        (eth, coins) = abi.decode(poolManager.unlock(abi.encode(OP_COLLECT, abi.encode(coin))), (uint256, uint256));
        address creator = NullNFTCollection(payable(collection)).creator();
        uint256 bps = creatorFeeBpsOf[collection];
        uint256 creatorEth = (eth * bps) / 10_000;
        uint256 creatorCoins = (coins * bps) / 10_000;
        _pay(creator, creatorEth);
        _pay(feeRecipient, eth - creatorEth);
        if (creatorCoins > 0) IERC20(coin).safeTransfer(creator, creatorCoins);
        if (coins > creatorCoins) IERC20(coin).safeTransfer(feeRecipient, coins - creatorCoins);
        emit FeesCollected(collection, eth, coins, creatorEth, creatorCoins);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (uint8 op, bytes memory payload) = abi.decode(data, (uint8, bytes));
        if (op == OP_OPEN) return _open(payload);
        return _collect(payload);
    }

    function _open(bytes memory payload) private returns (bytes memory) {
        (address collection, address coin, uint256 ethAmount, uint256 coinAmount, uint160 target) =
            abi.decode(payload, (address, address, uint256, uint256, uint160));
        PoolKey memory key = poolKey(coin);
        PoolId id = poolId(coin);
        int256 ethDelta; // our running balance with the pool manager (negative = we owe it)
        int256 coinDelta;

        // Someone may have initialized this pool earlier at another price. Nobody else can hold coins before
        // this moment, so any liquidity in the way is ETH only and sits on the side we never cross at a loss:
        // moving the price to the mint price is free or buys coins' worth of ETH cheaply. Do it, then add.
        (uint160 current,,,) = poolManager.getSlot0(id);
        if (current != target) {
            bool zeroForOne = current > target; // price (coins per ETH) has to go down: put ETH in
            BalanceDelta s = poolManager.swap(
                key,
                SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(zeroForOne ? ethAmount : coinAmount), sqrtPriceLimitX96: target}),
                ""
            );
            ethDelta += s.amount0();
            coinDelta += s.amount1();
        }

        (uint160 price,,,) = poolManager.getSlot0(id);
        uint128 liquidity = _liquidityFor(price, uint256(int256(ethAmount) + ethDelta), uint256(int256(coinAmount) + coinDelta));
        if (liquidity > 0) {
            (BalanceDelta d,) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: int256(uint256(liquidity)), salt: bytes32(0)}),
                ""
            );
            ethDelta += d.amount0();
            coinDelta += d.amount1();
        }
        // (liquidity 0 only if someone parked so much ETH in the way that the price move used up all our coins:
        //  they bought them above the mint price, every coin is still backed, and the ETH goes to the payout)
        _settle(key.currency0, ethDelta);
        _settle(key.currency1, coinDelta);
        liquidityOf[collection] = liquidity;
        return abi.encode(uint256(int256(ethAmount) + ethDelta), uint256(int256(coinAmount) + coinDelta));
    }

    function _collect(bytes memory payload) private returns (bytes memory) {
        address coin = abi.decode(payload, (address));
        PoolKey memory key = poolKey(coin);
        (BalanceDelta d,) = poolManager.modifyLiquidity(
            key, ModifyLiquidityParams({tickLower: TICK_LOWER, tickUpper: TICK_UPPER, liquidityDelta: 0, salt: bytes32(0)}), ""
        );
        int256 e = d.amount0();
        int256 c = d.amount1();
        _settle(key.currency0, e);
        _settle(key.currency1, c);
        return abi.encode(uint256(e > 0 ? e : int256(0)), uint256(c > 0 ? c : int256(0)));
    }

    /// @dev Pays what we owe the pool manager (delta < 0) or takes what it owes us (delta > 0).
    function _settle(Currency currency, int256 delta) private {
        if (delta < 0) {
            uint256 amount = uint256(-delta);
            if (currency.isAddressZero()) {
                poolManager.settle{value: amount}();
            } else {
                poolManager.sync(currency);
                IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), amount);
                poolManager.settle();
            }
        } else if (delta > 0) {
            poolManager.take(currency, address(this), uint256(delta));
        }
    }

    /// @notice sqrt(coins per ETH) in Q64.96, the pool price at which `coinAmount` coins cost `ethAmount`.
    function sqrtPriceFor(uint256 ethAmount, uint256 coinAmount) public pure returns (uint160) {
        uint256 ratioX96 = FullMath.mulDiv(coinAmount, 1 << 96, ethAmount);
        return uint160(Math.sqrt(ratioX96) << 48);
    }

    /// @dev Full-range liquidity for the given amounts at `sqrtPrice`, trimmed by 0.001% so rounding never asks
    ///      for more than we have.
    function _liquidityFor(uint160 sqrtPrice, uint256 amount0, uint256 amount1) private pure returns (uint128) {
        uint160 a = TickMath.getSqrtPriceAtTick(TICK_LOWER);
        uint160 b = TickMath.getSqrtPriceAtTick(TICK_UPPER);
        uint256 q96 = 1 << 96;
        uint256 l;
        if (sqrtPrice <= a) {
            l = FullMath.mulDiv(amount0, FullMath.mulDiv(a, b, q96), b - a);
        } else if (sqrtPrice < b) {
            uint256 l0 = FullMath.mulDiv(amount0, FullMath.mulDiv(sqrtPrice, b, q96), b - sqrtPrice);
            uint256 l1 = FullMath.mulDiv(amount1, q96, sqrtPrice - a);
            l = l0 < l1 ? l0 : l1;
        } else {
            l = FullMath.mulDiv(amount1, q96, b - a);
        }
        if (l <= 1) return 0;
        l -= l / 100_000 + 1;
        return uint128(l);
    }

    // ------------------------------------------------------------------ payouts & settings

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) owed[to] += amount;
    }

    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert PayFailed();
    }

    /// @notice Applies to collections launched after the change; feeRecipient applies everywhere.
    function setSettings(address feeRecipient_, uint256 launchFee_, uint16 mintFeeBps_, uint16 lpBps_, uint16 creatorFeeBps_) external onlyOwner {
        if (feeRecipient_ == address(0) || mintFeeBps_ > 2_000 || lpBps_ < 500 || lpBps_ > 5_000 || creatorFeeBps_ > 10_000) revert BadSetting();
        feeRecipient = feeRecipient_;
        launchFee = launchFee_;
        mintFeeBps = mintFeeBps_;
        lpBps = lpBps_;
        creatorFeeBps = creatorFeeBps_;
        emit SettingsChanged(feeRecipient_, launchFee_, mintFeeBps_, lpBps_, creatorFeeBps_);
    }

    // ------------------------------------------------------------------ views

    function collectionsCount() external view returns (uint256) {
        return collections.length;
    }

    /// @notice Newest first: collections[count-1-start] down to count-start-count.
    function latest(uint256 start, uint256 count) external view returns (NullNFTCollection.Info[] memory out) {
        uint256 n = collections.length;
        if (start >= n) return new NullNFTCollection.Info[](0);
        uint256 m = n - start < count ? n - start : count;
        out = new NullNFTCollection.Info[](m);
        for (uint256 i = 0; i < m; i++) out[i] = NullNFTCollection(payable(collections[n - 1 - start - i])).info();
    }

    receive() external payable {} // ETH from the pool manager (take) and refunds
}
