// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {NullSwapERC20} from "./NullSwapERC20.sol";

interface INullSwapFeeSink {
    function onPoolFee(address token, uint256 amount) external;
}

/// @title NullSwapPair — Uniswap V2 pair port for (launched token, WETH)
/// @notice Differences from Uniswap V2:
///   - A fee of `feeBps` (1% trade fee + the token's creator tax) is charged on the WETH side of every
///     swap and sent out of the pool to the fee sink (the launchpad), which splits it between the
///     platform and the creator. There is no LP fee: graduated liquidity is locked forever at 0x…dEaD.
///   - No flash swaps (no callback data), no protocol fee switch, no permit.
///   - MINIMUM_LIQUIDITY is locked at 0x…dEaD.
///   Swap/Sync/Mint/Burn events keep the Uniswap V2 signatures so standard indexers can read them.
contract NullSwapPair is NullSwapERC20 {
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;
    uint256 public constant BPS = 10_000;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address public immutable factory;
    address public token0;
    address public token1;
    address public token; // the launched token
    address public weth;
    address public feeSink;
    uint16 public feeBps;
    bool public wethIsToken0;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    uint256 private unlocked = 1;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
    event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to);
    event Sync(uint112 reserve0, uint112 reserve1);
    event FeeTaken(uint256 amount);

    error Forbidden();
    error Locked();
    error AlreadyInitialized();
    error BadFee();
    error Overflow();
    error InsufficientLiquidityMinted();
    error InsufficientLiquidityBurned();
    error InsufficientOutputAmount();
    error InsufficientLiquidity();
    error InsufficientInputAmount();
    error InvalidTo();
    error KInvariant();
    error TransferFailed();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 0;
        _;
        unlocked = 1;
    }

    constructor() {
        factory = msg.sender;
    }

    function initialize(address token_, address weth_, address feeSink_, uint16 feeBps_) external {
        if (msg.sender != factory) revert Forbidden();
        if (token0 != address(0)) revert AlreadyInitialized();
        if (feeBps_ > 1_000) revert BadFee(); // never above 10%
        token = token_;
        weth = weth_;
        feeSink = feeSink_;
        feeBps = feeBps_;
        (token0, token1) = token_ < weth_ ? (token_, weth_) : (weth_, token_);
        wethIsToken0 = token0 == weth_;
    }

    function getReserves() public view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast) {
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = blockTimestampLast;
    }

    function _safeTransfer(address tok, address to, uint256 value) private {
        (bool ok, bytes memory data) = tok.call(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _update(uint256 balance0, uint256 balance1, uint112 _reserve0, uint112 _reserve1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
        unchecked {
            uint32 timeElapsed = blockTimestamp - blockTimestampLast; // overflow is desired
            if (timeElapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += (uint256(_reserve1) << 112) / _reserve0 * timeElapsed;
                price1CumulativeLast += (uint256(_reserve0) << 112) / _reserve1 * timeElapsed;
            }
        }
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = blockTimestamp;
        emit Sync(reserve0, reserve1);
    }

    function mint(address to) external lock returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        uint256 _totalSupply = totalSupply;
        if (_totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(DEAD, MINIMUM_LIQUIDITY);
        } else {
            uint256 l0 = amount0 * _totalSupply / _reserve0;
            uint256 l1 = amount1 * _totalSupply / _reserve1;
            liquidity = l0 < l1 ? l0 : l1;
        }
        if (liquidity == 0) revert InsufficientLiquidityMinted();
        _mint(to, liquidity);
        _update(balance0, balance1, _reserve0, _reserve1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function burn(address to) external lock returns (uint256 amount0, uint256 amount1) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        address _token0 = token0;
        address _token1 = token1;
        uint256 balance0 = IERC20(_token0).balanceOf(address(this));
        uint256 balance1 = IERC20(_token1).balanceOf(address(this));
        uint256 liquidity = balanceOf[address(this)];
        uint256 _totalSupply = totalSupply;
        amount0 = liquidity * balance0 / _totalSupply;
        amount1 = liquidity * balance1 / _totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidityBurned();
        _burn(address(this), liquidity);
        _safeTransfer(_token0, to, amount0);
        _safeTransfer(_token1, to, amount1);
        balance0 = IERC20(_token0).balanceOf(address(this));
        balance1 = IERC20(_token1).balanceOf(address(this));
        _update(balance0, balance1, _reserve0, _reserve1);
        emit Burn(msg.sender, amount0, amount1, to);
    }

    /// @notice Uniswap V2 style swap without flash-swap callback. Tokens must be sent in beforehand.
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external lock {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint112 _r0, uint112 _r1,) = getReserves();
        if (amount0Out >= _r0 || amount1Out >= _r1) revert InsufficientLiquidity();
        if (to == token0 || to == token1) revert InvalidTo();
        if (amount0Out > 0) _safeTransfer(token0, to, amount0Out);
        if (amount1Out > 0) _safeTransfer(token1, to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 a0In = b0 > _r0 - amount0Out ? b0 - (_r0 - amount0Out) : 0;
        uint256 a1In = b1 > _r1 - amount1Out ? b1 - (_r1 - amount1Out) : 0;
        if (a0In == 0 && a1In == 0) revert InsufficientInputAmount();

        // Fee on the WETH side: feeBps of WETH in, and feeBps of the gross WETH out (out + fee).
        uint256 fee;
        {
            (uint256 wIn, uint256 wOut) = wethIsToken0 ? (a0In, amount0Out) : (a1In, amount1Out);
            uint256 f = feeBps;
            fee = wIn * f / BPS;
            if (wOut > 0) fee += (wOut * f + (BPS - f) - 1) / (BPS - f);
        }
        if (fee > 0) {
            _safeTransfer(weth, feeSink, fee);
            if (wethIsToken0) b0 -= fee;
            else b1 -= fee;
        }
        if (b0 * b1 < uint256(_r0) * uint256(_r1)) revert KInvariant();
        _update(b0, b1, _r0, _r1);
        if (fee > 0) {
            INullSwapFeeSink(feeSink).onPoolFee(token, fee);
            emit FeeTaken(fee);
        }
        emit Swap(msg.sender, a0In, a1In, amount0Out, amount1Out, to);
    }

    function skim(address to) external lock {
        _safeTransfer(token0, to, IERC20(token0).balanceOf(address(this)) - reserve0);
        _safeTransfer(token1, to, IERC20(token1).balanceOf(address(this)) - reserve1);
    }

    function sync() external lock {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)), reserve0, reserve1);
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
