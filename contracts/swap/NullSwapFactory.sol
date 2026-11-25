// SPDX-License-Identifier: MIT
pragma solidity 0.8.39;

import {NullSwapPair} from "./NullSwapPair.sol";

/// @title NullSwapFactory
/// @notice Pairs are always (launched token, WETH), deployed with CREATE2 (salt = token), and only the
///         launchpad that deployed this factory can create them. Nobody can open a pool for a token
///         before it graduates, so a pool can never be seeded at a manipulated price.
contract NullSwapFactory {
    address public immutable launchpad;
    address public immutable weth;

    mapping(address => address) public pairOf; // token => pair
    address[] public allPairs;

    // Same signature as Uniswap V2 so standard indexers recognise it.
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    error Forbidden();
    error PairExists();
    error BadToken();

    constructor(address weth_) {
        launchpad = msg.sender;
        weth = weth_;
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }

    /// @notice Uniswap V2 compatible lookup.
    function getPair(address tokenA, address tokenB) external view returns (address) {
        if (tokenA == weth) return pairOf[tokenB];
        if (tokenB == weth) return pairOf[tokenA];
        return address(0);
    }

    function pairCodeHash() public pure returns (bytes32) {
        return keccak256(type(NullSwapPair).creationCode);
    }

    /// @notice Deterministic pair address for `token`, whether or not it exists yet.
    function pairFor(address token) public view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), keccak256(abi.encodePacked(token)), pairCodeHash())))));
    }

    function createPair(address token, uint16 feeBps) external returns (address pair) {
        if (msg.sender != launchpad) revert Forbidden();
        if (token == address(0) || token == weth) revert BadToken();
        if (pairOf[token] != address(0)) revert PairExists();
        pair = address(new NullSwapPair{salt: keccak256(abi.encodePacked(token))}());
        NullSwapPair(pair).initialize(token, weth, launchpad, feeBps);
        pairOf[token] = pair;
        allPairs.push(pair);
        (address t0, address t1) = token < weth ? (token, weth) : (weth, token);
        emit PairCreated(t0, t1, pair, allPairs.length);
    }
}
