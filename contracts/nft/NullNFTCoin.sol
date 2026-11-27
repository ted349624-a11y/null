// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title NullNFTCoin
/// @notice The coin of one null_ NFT collection. Every coin in circulation is backed by an NFT held in the
///         collection's vault: only the collection mints (an NFT turned into coins) and burns (coins turned
///         back into an NFT). Deployed as a minimal-proxy clone, so name and symbol live in storage.
contract NullNFTCoin is ERC20 {
    address public collection;
    string private _name;
    string private _symbol;

    error OnlyCollection();
    error AlreadyInitialized();

    constructor() ERC20("", "") {
        collection = address(1); // the implementation itself can never be initialized
    }

    function initialize(string calldata name_, string calldata symbol_, address collection_) external {
        if (collection != address(0)) revert AlreadyInitialized();
        collection = collection_;
        _name = name_;
        _symbol = symbol_;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != collection) revert OnlyCollection();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != collection) revert OnlyCollection();
        _burn(from, amount);
    }
}
