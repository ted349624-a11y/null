// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {NullNFTCoin} from "./NullNFTCoin.sol";
import {NullNFTArt} from "./NullNFTArt.sol";

interface INullNFTFactory {
    function openPool(address coin, uint256 coinAmount) external payable returns (uint256 ethLeft, uint256 coinLeft);
    function feeRecipient() external view returns (address);
}

/// @title NullNFTCollection
/// @notice One NFT collection on null_, tied to its own coin at a fixed rate: every NFT holds `perNFT` coins.
///         - Mint: anyone mints at `mintPrice` until `mintEnd` or until the public share is sold out.
///         - Finalize: part of the mint revenue and the coins of a few extra NFTs (kept in the vault) open a
///           Uniswap v4 pool at the mint price, locked for good by the factory. The rest goes to the creator,
///           minus the platform's mint fee.
///         - After that, any NFT can be turned into its coins (the NFT goes into the vault) and `perNFT` coins can
///           be turned back into a random NFT from the vault. Coins in circulation always equal
///           perNFT x NFTs in the vault, so every coin is backed.
///         Deployed as a minimal-proxy clone by NullNFTFactory.
contract NullNFTCollection is ERC721, ReentrancyGuardTransient, IERC721Receiver {
    struct Config {
        string name;
        string symbol;
        uint32 nftSupply;
        uint32 maxPerWallet; // 0 = no limit
        uint64 mintEnd;
        uint16 mintFeeBps;
        uint16 lpBps;
        uint256 perNFT;
        uint256 mintPrice;
    }

    struct Info {
        address collection;
        address coin;
        address creator;
        string name;
        string symbol;
        uint256 nftSupply;
        uint256 perNFT;
        uint256 mintPrice;
        uint256 mintEnd;
        uint256 maxPerWallet;
        uint256 minted;
        uint256 publicCap;
        uint256 totalNFTs;
        uint256 vaultSize;
        bool finalized;
        uint256 mintFeeBps;
        uint256 lpBps;
        bytes32 seed; // the art: NullNFTArt.image(symbol, id, seed)
    }

    uint256 public constant MAX_PER_TX = 20;
    uint256 public constant MAX_CONVERT = 50;

    address public factory;
    address public creator;
    NullNFTCoin public coin;
    string private _name;
    string private _symbol;
    uint32 public nftSupply;
    uint32 public maxPerWallet;
    uint64 public mintEnd;
    uint16 public mintFeeBps;
    uint16 public lpBps;
    uint256 public perNFT;
    uint256 public mintPrice;
    bytes32 public seed;

    uint32 public minted; // NFTs sold in the mint
    uint32 public totalNFTs; // ids 1..totalNFTs exist (minted ones plus the pool's share)
    bool public finalized;
    uint256 private _nonce;
    uint256[] private _vault;
    mapping(address => uint256) public mintedBy;
    mapping(address => uint256) public owed; // payouts that could not be pushed

    event Minted(address indexed to, uint256 firstId, uint256 quantity);
    event Finalized(uint256 minted, uint256 poolNFTs, uint256 poolEth, uint256 poolCoins, uint256 creatorEth, uint256 platformEth);
    event ToCoins(address indexed account, uint256[] ids, uint256 coins);
    event ToNFTs(address indexed account, uint256[] ids, uint256 coins);

    error AlreadyInitialized();
    error MintClosed();
    error BadQuantity();
    error WrongValue();
    error SoldOut();
    error WalletLimit();
    error AlreadyFinalized();
    error MintRunning();
    error NotOpen();
    error NotOwner();
    error VaultTooSmall();
    error OnlyFactory();
    error NothingOwed();
    error PayFailed();

    constructor() ERC721("", "") {
        factory = address(1); // the implementation itself can never be initialized
    }

    function initialize(address creator_, address coin_, Config calldata c) external {
        if (factory != address(0)) revert AlreadyInitialized();
        factory = msg.sender;
        creator = creator_;
        coin = NullNFTCoin(coin_);
        _name = c.name;
        _symbol = c.symbol;
        nftSupply = c.nftSupply;
        maxPerWallet = c.maxPerWallet;
        mintEnd = c.mintEnd;
        mintFeeBps = c.mintFeeBps;
        lpBps = c.lpBps;
        perNFT = c.perNFT;
        mintPrice = c.mintPrice;
        seed = keccak256(abi.encode(address(this), creator_, block.prevrandao, block.timestamp, blockhash(block.number - 1)));
    }

    // ------------------------------------------------------------------ mint

    /// @notice NFTs that go into the vault to back the pool's coins when `m` NFTs were sold (at least one).
    function poolNFTs(uint256 m) public view returns (uint256) {
        if (m == 0) return 0;
        uint256 k = (m * lpBps) / 10_000;
        return k == 0 ? 1 : k;
    }

    /// @notice How many NFTs the public can mint: the largest m with m + poolNFTs(m) <= nftSupply.
    function publicCap() public view returns (uint256 m) {
        m = (uint256(nftSupply) * 10_000) / (10_000 + lpBps);
        while (m > 0 && m + poolNFTs(m) > nftSupply) m--;
        while (m + 1 + poolNFTs(m + 1) <= nftSupply) m++;
    }

    function soldOut() public view returns (bool) {
        uint256 m = minted;
        return m + 1 + poolNFTs(m + 1) > nftSupply;
    }

    function mint(uint256 quantity) external payable nonReentrant {
        if (finalized || block.timestamp >= mintEnd) revert MintClosed();
        if (quantity == 0 || quantity > MAX_PER_TX) revert BadQuantity();
        if (msg.value != quantity * mintPrice) revert WrongValue();
        uint256 m = uint256(minted) + quantity;
        if (m + poolNFTs(m) > nftSupply) revert SoldOut();
        if (maxPerWallet != 0 && mintedBy[msg.sender] + quantity > maxPerWallet) revert WalletLimit();
        mintedBy[msg.sender] += quantity;
        minted = uint32(m);
        uint256 first = uint256(totalNFTs) + 1;
        totalNFTs = uint32(first + quantity - 1);
        for (uint256 i = 0; i < quantity; i++) _mint(msg.sender, first + i);
        emit Minted(msg.sender, first, quantity);
        // Sold out: the last mint also opens trading. This is deliberately not optional (no try/catch):
        // wallets estimate gas on the cheapest path that succeeds, so an optional step would be skipped.
        if (soldOut()) _finalize();
    }

    // ------------------------------------------------------------------ finalize

    /// @notice Ends the mint (after mintEnd, or once sold out), opens the Uniswap v4 pool and pays out.
    function finalize() external nonReentrant {
        _finalize();
    }

    function _finalize() private {
        if (finalized) revert AlreadyFinalized();
        uint256 m = minted;
        if (block.timestamp < mintEnd && !soldOut()) revert MintRunning();
        finalized = true;
        if (m == 0) {
            emit Finalized(0, 0, 0, 0, 0, 0);
            return;
        }
        uint256 k = poolNFTs(m);
        uint256 first = uint256(totalNFTs) + 1;
        totalNFTs = uint32(first + k - 1);
        for (uint256 i = 0; i < k; i++) {
            _mint(address(this), first + i);
            _vault.push(first + i);
        }

        uint256 revenue = address(this).balance;
        uint256 platformEth = (revenue * mintFeeBps) / 10_000;
        uint256 poolEth = k * mintPrice; // opens the pool at the mint price: perNFT coins = mintPrice
        if (poolEth > revenue - platformEth) poolEth = revenue - platformEth;
        uint256 poolCoins = k * perNFT;

        coin.mint(factory, poolCoins);
        INullNFTFactory(factory).openPool{value: poolEth}(address(coin), poolCoins); // unused ETH comes back

        uint256 bal = address(this).balance;
        if (platformEth > bal) platformEth = bal;
        uint256 creatorEth = bal - platformEth;
        _pay(INullNFTFactory(factory).feeRecipient(), platformEth);
        _pay(creator, creatorEth);
        emit Finalized(m, k, poolEth, poolCoins, creatorEth, platformEth);
    }

    // ------------------------------------------------------------------ NFT <-> coins

    /// @notice Turns your NFTs into coins: each NFT goes into the vault and you get `perNFT` coins for it.
    function toCoins(uint256[] calldata ids) external nonReentrant {
        if (!finalized) revert NotOpen();
        uint256 n = ids.length;
        if (n == 0 || n > MAX_CONVERT) revert BadQuantity();
        for (uint256 i = 0; i < n; i++) {
            if (_ownerOf(ids[i]) != msg.sender) revert NotOwner();
            _transfer(msg.sender, address(this), ids[i]);
            _vault.push(ids[i]);
        }
        coin.mint(msg.sender, n * perNFT);
        emit ToCoins(msg.sender, ids, n * perNFT);
    }

    /// @notice Turns `n * perNFT` of your coins back into `n` NFTs, picked at random from the vault.
    function toNFTs(uint256 n) external nonReentrant returns (uint256[] memory ids) {
        if (!finalized) revert NotOpen();
        if (n == 0 || n > MAX_CONVERT) revert BadQuantity();
        if (n > _vault.length) revert VaultTooSmall();
        coin.burn(msg.sender, n * perNFT);
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 len = _vault.length;
            uint256 r = uint256(keccak256(abi.encode(blockhash(block.number - 1), block.timestamp, msg.sender, _nonce++, len))) % len;
            uint256 id = _vault[r];
            _vault[r] = _vault[len - 1];
            _vault.pop();
            _transfer(address(this), msg.sender, id);
            ids[i] = id;
        }
        emit ToNFTs(msg.sender, ids, n * perNFT);
    }

    /// @notice An NFT sent here with safeTransferFrom is turned into coins for the sender.
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != address(this)) revert NotOwner(); // only our own NFTs
        if (from != address(0)) {
            if (!finalized) revert NotOpen();
            _vault.push(tokenId);
            coin.mint(from, perNFT);
            uint256[] memory ids = new uint256[](1);
            ids[0] = tokenId;
            emit ToCoins(from, ids, perNFT);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // ------------------------------------------------------------------ payouts

    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) owed[to] += amount;
    }

    /// @notice Collects a payout that could not be sent at finalize (e.g. a contract wallet that refused ETH).
    function withdrawOwed() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert PayFailed();
    }

    receive() external payable {
        if (msg.sender != factory) revert OnlyFactory(); // the pool's unused ETH
    }

    // ------------------------------------------------------------------ views

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireOwned(id);
        return NullNFTArt.tokenURI(_name, _symbol, id, seed, perNFT);
    }

    function contractURI() external view returns (string memory) {
        return NullNFTArt.contractURI(_name, _symbol, seed, perNFT);
    }

    function vaultSize() external view returns (uint256) {
        return _vault.length;
    }

    function vaultIds(uint256 start, uint256 count) external view returns (uint256[] memory ids) {
        uint256 len = _vault.length;
        if (start >= len) return new uint256[](0);
        uint256 end = start + count > len ? len : start + count;
        ids = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) ids[i - start] = _vault[i];
    }

    /// @notice Ids in [from, from + count) owned by `owner`; page through 1..totalNFTs to list a wallet.
    function ownedIds(address owner, uint256 from, uint256 count) external view returns (uint256[] memory ids) {
        if (from == 0) from = 1;
        uint256 end = from + count;
        if (end > uint256(totalNFTs) + 1) end = uint256(totalNFTs) + 1;
        if (from >= end) return new uint256[](0);
        uint256[] memory tmp = new uint256[](end - from);
        uint256 n;
        for (uint256 id = from; id < end; id++) if (_ownerOf(id) == owner) tmp[n++] = id;
        ids = new uint256[](n);
        for (uint256 i = 0; i < n; i++) ids[i] = tmp[i];
    }

    function info() external view returns (Info memory) {
        return Info({
            collection: address(this),
            coin: address(coin),
            creator: creator,
            name: _name,
            symbol: _symbol,
            nftSupply: nftSupply,
            perNFT: perNFT,
            mintPrice: mintPrice,
            mintEnd: mintEnd,
            maxPerWallet: maxPerWallet,
            minted: minted,
            publicCap: publicCap(),
            totalNFTs: totalNFTs,
            vaultSize: _vault.length,
            finalized: finalized,
            mintFeeBps: mintFeeBps,
            lpBps: lpBps,
            seed: seed
        });
    }
}
