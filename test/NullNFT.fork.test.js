// NFT <-> coin collections against the real Uniswap v4 on a local copy of Base Sepolia.
// Run: FORK_BASE_SEPOLIA=1 USE_LOCAL_SOLC=1 npx hardhat test test/NullNFT.fork.test.js
//  or: FORK_ROBINHOOD=1 USE_LOCAL_SOLC=1 npx hardhat test test/NullNFT.fork.test.js   (Robinhood Chain mainnet copy)
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const V4 = process.env.FORK_ROBINHOOD
  ? {
      poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      universalRouter: process.env.UR || "0x8876789976decbfcbbbe364623c63652db8c0904",
      stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    }
  : {
      poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
      universalRouter: "0x492E6456D9528771018DeB9E87ef7750EF184104",
      stateView: "0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4",
      permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    };
const E = (x) => ethers.parseEther(String(x));
const coder = ethers.AbiCoder.defaultAbiCoder();
const KEY_T = "tuple(address,address,uint24,int24,address)";

const fork = process.env.FORK_BASE_SEPOLIA || process.env.FORK_ROBINHOOD ? describe : describe.skip;

fork(`null_ NFT collections (${process.env.FORK_ROBINHOOD ? "Robinhood Chain" : "Base Sepolia"} fork, real Uniswap v4)`, function () {
  this.timeout(900_000);
  let factory, owner, fees, creator, a, b, c, attacker, stateView, permit2, router;
  const LAUNCH_FEE = E("0.0005");

  async function launch(over = {}) {
    const p = { name: "Null Cats", symbol: "NCAT", nftSupply: 100, coinSupply: 100, mintPrice: E("0.001"), duration: 3600, maxPerWallet: 0, ...over };
    const tx = await factory.connect(creator).createCollection(p, { value: LAUNCH_FEE });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "CollectionCreated");
    const col = await ethers.getContractAt("NullNFTCollection", ev.args.collection);
    const coin = await ethers.getContractAt("NullNFTCoin", ev.args.coin);
    FEES[ev.args.coin] = Number(await factory.feeOf(ev.args.coin));
    return { col, coin, p };
  }
  const FEES = {}; // coin -> pool fee, read from the factory
  const keyOf = (coin) => [ethers.ZeroAddress, coin, FEES[coin] ?? 30000, 200, ethers.ZeroAddress];
  async function price(coinAddr) {
    const [sqrtP] = await stateView.getSlot0(await factory.poolId(coinAddr));
    return Number((sqrtP * sqrtP * 10n ** 9n) >> 192n) / 1e9; // coins per ETH
  }
  async function backed(col, coin) {
    expect(await coin.totalSupply()).to.equal((await col.perNFT()) * (await col.vaultSize()));
  }
  async function swap(user, coinAddr, zeroForOne, amountIn, minOut = 0n) {
    const params = coder.encode([`tuple(${KEY_T},bool,uint128,uint128,bytes)`], [[keyOf(coinAddr), zeroForOne, amountIn, minOut, "0x"]]);
    const inCur = zeroForOne ? ethers.ZeroAddress : coinAddr;
    const outCur = zeroForOne ? coinAddr : ethers.ZeroAddress;
    const settle = coder.encode(["address", "uint256"], [inCur, amountIn]);
    const take = coder.encode(["address", "uint256"], [outCur, minOut]);
    const input = coder.encode(["bytes", "bytes[]"], ["0x060c0f", [params, settle, take]]);
    if (!zeroForOne) {
      const coin = await ethers.getContractAt("NullNFTCoin", coinAddr);
      await (await coin.connect(user).approve(V4.permit2, ethers.MaxUint256)).wait();
      await (await permit2.connect(user).approve(coinAddr, V4.universalRouter, (1n << 160n) - 1n, 2n ** 47n)).wait();
    }
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
    return (await router.connect(user).execute("0x10", [input], deadline, { value: zeroForOne ? amountIn : 0n })).wait();
  }

  before(async () => {
    [owner, fees, creator, a, b, c, attacker] = await ethers.getSigners();
    const col = await (await ethers.getContractFactory("NullNFTCollection")).deploy();
    const coin = await (await ethers.getContractFactory("NullNFTCoin")).deploy();
    factory = await (await ethers.getContractFactory("NullNFTFactory")).deploy(V4.poolManager, await col.getAddress(), await coin.getAddress(), owner.address, fees.address, LAUNCH_FEE);
    stateView = new ethers.Contract(V4.stateView, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)", "function getLiquidity(bytes32) view returns (uint128)"], owner);
    permit2 = new ethers.Contract(V4.permit2, ["function approve(address token, address spender, uint160 amount, uint48 expiration)"], owner);
    router = new ethers.Contract(V4.universalRouter, ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"], owner);
  });

  it("rejects bad launches", async () => {
    const base = { name: "X", symbol: "X", nftSupply: 100, coinSupply: 100, mintPrice: E("0.001"), duration: 3600, maxPerWallet: 0 };
    await expect(factory.connect(creator).createCollection(base, { value: 0 })).to.be.revertedWithCustomError(factory, "WrongLaunchFee");
    await expect(factory.connect(creator).createCollection({ ...base, name: 'bad"name' }, { value: LAUNCH_FEE })).to.be.revertedWithCustomError(factory, "BadText");
    await expect(factory.connect(creator).createCollection({ ...base, nftSupply: 3, coinSupply: 1 }, { value: LAUNCH_FEE })).to.be.revertedWithCustomError(factory, "UnevenSplit");
    await expect(factory.connect(creator).createCollection({ ...base, nftSupply: 1 }, { value: LAUNCH_FEE })).to.be.revertedWithCustomError(factory, "BadSupply");
  });

  let C; // the main collection, used across the next tests
  it("launches: 100 NFTs, 100 coins, 1 coin per NFT, 80 for the public", async () => {
    const feesBefore = await ethers.provider.getBalance(fees.address);
    C = await launch();
    expect(await C.col.name()).to.equal("Null Cats");
    expect(await C.coin.symbol()).to.equal("NCAT");
    expect(await C.col.perNFT()).to.equal(E(1));
    expect(await C.col.publicCap()).to.equal(80n);
    expect(await ethers.provider.getBalance(fees.address)).to.equal(feesBefore + LAUNCH_FEE);
    await expect(C.col.connect(a).toCoins([1])).to.be.revertedWithCustomError(C.col, "NotOpen");
  });

  it("mints, sells out at 80 and opens the pool in the same transaction", async () => {
    const creatorBefore = await ethers.provider.getBalance(creator.address);
    const feesBefore = await ethers.provider.getBalance(fees.address);
    await expect(C.col.connect(a).mint(2, { value: E("0.001") })).to.be.revertedWithCustomError(C.col, "WrongValue");
    for (const [u, n] of [[a, 20], [b, 20], [c, 20], [a, 19]]) await (await C.col.connect(u).mint(n, { value: E("0.001") * BigInt(n) })).wait();
    expect(await C.col.finalized()).to.equal(false);
    const est = await C.col.connect(b).mint.estimateGas(1, { value: E("0.001") });
    const last = await (await C.col.connect(b).mint(1, { value: E("0.001"), gasLimit: est })).wait(); // the 80th, with exactly the estimate
    console.log(`      last mint: estimate ${est}, used ${last.gasUsed}`);
    expect(await C.col.finalized()).to.equal(true);
    expect(await C.col.totalNFTs()).to.equal(100n);
    expect(await C.col.vaultSize()).to.equal(20n);
    await backed(C.col, C.coin);
    await expect(C.col.connect(a).mint(1, { value: E("0.001") })).to.be.revertedWithCustomError(C.col, "MintClosed");
    // pool at the mint price: 1 coin = 0.001 ETH -> 1000 coins per ETH
    expect(await price(await C.coin.getAddress())).to.be.closeTo(1000, 0.001);
    expect(await factory.liquidityOf(await C.col.getAddress())).to.be.gt(0n);
    // payouts: 0.08 ETH raised -> 5% platform, 0.02 ETH into the pool, the rest to the creator
    const creatorGot = (await ethers.provider.getBalance(creator.address)) - creatorBefore;
    const feesGot = (await ethers.provider.getBalance(fees.address)) - feesBefore;
    expect(feesGot).to.equal(E("0.004"));
    expect(creatorGot).to.be.closeTo(E("0.056"), E("0.000001"));
    console.log(`      payouts: platform ${ethers.formatEther(feesGot)} ETH, creator ${ethers.formatEther(creatorGot)} ETH`);
  });

  it("turns NFTs into coins and back, always fully backed", async () => {
    const ids = await C.col.ownedIds(a.address, 1, 100);
    expect(ids.length).to.equal(39);
    await expect(C.col.connect(b).toCoins([ids[0]])).to.be.revertedWithCustomError(C.col, "NotOwner");
    await (await C.col.connect(a).toCoins([ids[0], ids[1]])).wait();
    expect(await C.coin.balanceOf(a.address)).to.equal(E(2));
    expect(await C.col.ownerOf(ids[0])).to.equal(await C.col.getAddress());
    expect(await C.col.vaultSize()).to.equal(22n);
    await backed(C.col, C.coin);
    const tx = await C.col.connect(a).toNFTs(1);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return C.col.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "ToNFTs");
    const got = ev.args.ids[0];
    expect(await C.col.ownerOf(got)).to.equal(a.address);
    expect(await C.coin.balanceOf(a.address)).to.equal(E(1));
    expect(await C.col.vaultSize()).to.equal(21n);
    await backed(C.col, C.coin);
    // safeTransferFrom straight to the collection also converts
    await (await C.col.connect(a)["safeTransferFrom(address,address,uint256)"](a.address, await C.col.getAddress(), ids[2])).wait();
    expect(await C.coin.balanceOf(a.address)).to.equal(E(2));
    await backed(C.col, C.coin);
    console.log(`      random NFT from the vault: #${got}`);
  });

  it("trades on Uniswap v4 through the Universal Router, and coins bought turn into NFTs", async () => {
    const coinAddr = await C.coin.getAddress();
    // sell 1 coin
    const ethBefore = await ethers.provider.getBalance(a.address);
    await swap(a, coinAddr, false, E(1));
    expect(await C.coin.balanceOf(a.address)).to.equal(E(1));
    expect(await ethers.provider.getBalance(a.address)).to.be.gt(ethBefore - E("0.0001")); // got ~0.00095 ETH back, minus gas
    // buy coins with ETH and turn them into an NFT
    await swap(c, coinAddr, true, E("0.003"));
    const bal = await C.coin.balanceOf(c.address);
    console.log(`      0.003 ETH bought ${ethers.formatEther(bal)} NCAT; price now ${(await price(coinAddr)).toFixed(2)} NCAT/ETH`);
    expect(bal).to.be.gt(E(2));
    const vault = await C.col.vaultSize();
    await (await C.col.connect(c).toNFTs(2)).wait();
    expect(await C.col.vaultSize()).to.equal(vault - 2n);
    await backed(C.col, C.coin);
  });

  it("charges 3% on trades and splits it: 1% creator, 2% platform", async () => {
    const col = await C.col.getAddress();
    const cE = await ethers.provider.getBalance(creator.address);
    const fE = await ethers.provider.getBalance(fees.address);
    const cC = await C.coin.balanceOf(creator.address);
    const tx = await factory.connect(attacker).collectFees(col); // anyone can trigger it
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "FeesCollected");
    const { eth, coins, creatorEth, creatorCoins } = ev.args;
    expect(eth).to.be.gt(0n);
    expect(coins).to.be.gt(0n);
    expect(FEES[await C.coin.getAddress()]).to.equal(30000);
    expect(creatorEth).to.equal((eth * 3333n) / 10000n);
    expect(creatorCoins).to.equal((coins * 3333n) / 10000n);
    expect((await ethers.provider.getBalance(creator.address)) - cE).to.equal(creatorEth);
    expect((await ethers.provider.getBalance(fees.address)) - fE).to.equal(eth - creatorEth);
    expect((await C.coin.balanceOf(creator.address)) - cC).to.equal(creatorCoins);
    await backed(C.col, C.coin);
    console.log(`      fees: ${ethers.formatEther(eth)} ETH + ${ethers.formatEther(coins)} NCAT (a third to the creator)`);
  });

  it("draws the NFT on-chain (valid JSON + SVG)", async () => {
    const uri = await C.col.tokenURI(5);
    const json = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
    expect(json.name).to.equal("Null Cats #5");
    expect(json.attributes[0]).to.deep.equal({ trait_type: "Coins inside", value: "1 NCAT" });
    const svg = Buffer.from(json.image.split(",")[1], "base64").toString();
    expect(svg.startsWith("<svg")).to.equal(true);
    require("fs").writeFileSync("/tmp/nft5.svg", svg);
    require("fs").writeFileSync("/tmp/nft6.svg", Buffer.from(JSON.parse(Buffer.from((await C.col.tokenURI(6)).split(",")[1], "base64").toString()).image.split(",")[1], "base64").toString());
    const cjson = JSON.parse(Buffer.from((await C.col.contractURI()).split(",")[1], "base64").toString());
    expect(cjson.name).to.equal("Null Cats");
    await expect(C.col.tokenURI(9999)).to.be.reverted;
  });

  it("ends a mint that did not sell out after the deadline (3 of 100 sold)", async () => {
    const D = await launch({ name: "Slow Mint", symbol: "SLOW", coinSupply: 1_000_000, mintPrice: E("0.002") });
    expect(await D.col.perNFT()).to.equal(E(10_000));
    await (await D.col.connect(a).mint(3, { value: E("0.006") })).wait();
    await expect(D.col.finalize()).to.be.revertedWithCustomError(D.col, "MintRunning");
    await network.provider.send("evm_increaseTime", [3601]);
    await network.provider.send("evm_mine");
    await expect(D.col.connect(a).mint(1, { value: E("0.002") })).to.be.revertedWithCustomError(D.col, "MintClosed");
    await (await D.col.connect(b).finalize()).wait();
    expect(await D.col.totalNFTs()).to.equal(4n); // 3 sold + 1 backing the pool
    expect(await D.col.vaultSize()).to.equal(1n);
    expect(await price(await D.coin.getAddress())).to.be.closeTo(5_000_000, 1); // 10,000 coins = 0.002 ETH
    await backed(D.col, D.coin);
  });

  it("opens at the mint price even if someone initialized the pool first and parked ETH in it", async () => {
    const meddler = await (await ethers.getContractFactory("TestPoolMeddler")).deploy(V4.poolManager);
    const M = await launch({ name: "Meddled", symbol: "MDL", nftSupply: 10, coinSupply: 10, mintPrice: E("0.01") });
    const coinAddr = await M.coin.getAddress();
    // initialize at 1 coin per ETH (the right price is 100 coins per ETH: 1 coin = 0.01 ETH)
    const wrong = 1n << 96n;
    await (await meddler.connect(attacker).initialize(keyOf(coinAddr), wrong)).wait();
    // ETH-only liquidity above the price (ticks above 0)
    await (await meddler.connect(attacker).addLiquidity(keyOf(coinAddr), 200, 40000, E("0.1"), { value: E(5) })).wait();
    expect(await price(coinAddr)).to.be.closeTo(1, 0.001);
    const attackerEthInPool = E(5) - (await ethers.provider.getBalance(await meddler.getAddress()));
    const mtx = await (await M.col.connect(a).mint(8, { value: E("0.08") })).wait(); // 8 + 2 = 10: sold out
    console.log(`      last mint (opens the pool too) used ${mtx.gasUsed} gas`);
    expect(await M.col.finalized()).to.equal(true);
    const p = await price(coinAddr);
    console.log(`      pool price after open: ${p.toFixed(3)} MDL/ETH (target 100); attacker had ${ethers.formatEther(attackerEthInPool)} ETH parked`);
    expect(p).to.be.closeTo(100, 0.01);
    expect(await factory.liquidityOf(await M.col.getAddress())).to.be.gt(0n);
    await backed(M.col, M.coin);
  });

  it("lets only the owner change settings; a new pool fee applies to new collections only", async () => {
    await expect(factory.connect(creator).setSettings(fees.address, LAUNCH_FEE, 500, 2500, 3333, 10000)).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount");
    await expect(factory.connect(owner).setSettings(fees.address, LAUNCH_FEE, 500, 2500, 3333, 200000)).to.be.revertedWithCustomError(factory, "BadSetting");
    await (await factory.connect(owner).setSettings(fees.address, LAUNCH_FEE, 500, 2500, 5000, 10000)).wait();
    const N = await launch({ name: "One Percent", symbol: "ONEP", nftSupply: 10, coinSupply: 10, mintPrice: E("0.01") });
    expect(await factory.feeOf(await N.coin.getAddress())).to.equal(10000n);
    expect(await factory.feeOf(await C.coin.getAddress())).to.equal(30000n); // the earlier collection keeps 3%
    await (await N.col.connect(a).mint(8, { value: E("0.08") })).wait();
    expect(await price(await N.coin.getAddress())).to.be.closeTo(100, 0.01);
    await swap(b, await N.coin.getAddress(), true, E("0.005"));
    expect(await N.coin.balanceOf(b.address)).to.be.gt(0n);
    await (await factory.connect(owner).setSettings(fees.address, LAUNCH_FEE, 500, 2500, 3333, 30000)).wait(); // back to defaults
  });

  it("cannot be blocked: even a huge ETH wall in the way does not stop the mint from closing", async () => {
    const meddler = await (await ethers.getContractFactory("TestPoolMeddler")).deploy(V4.poolManager);
    const W = await launch({ name: "Walled", symbol: "WALL", nftSupply: 10, coinSupply: 10, mintPrice: E("0.01") });
    const coinAddr = await W.coin.getAddress();
    await (await meddler.connect(attacker).initialize(keyOf(coinAddr), 1n << 96n)).wait();
    await (await meddler.connect(attacker).addLiquidity(keyOf(coinAddr), 200, 40000, E(50), { value: E(100) })).wait();
    const creatorBefore = await ethers.provider.getBalance(creator.address);
    await (await W.col.connect(a).mint(8, { value: E("0.08") })).wait();
    expect(await W.col.finalized()).to.equal(true);
    await backed(W.col, W.coin);
    const creatorGot = (await ethers.provider.getBalance(creator.address)) - creatorBefore;
    console.log(`      walled pool: our liquidity ${await factory.liquidityOf(await W.col.getAddress())}, price ${(await price(coinAddr)).toFixed(3)}, creator got ${ethers.formatEther(creatorGot)} ETH (the wall bought our pool coins above the mint price)`);
    expect(creatorGot).to.be.gte(E("0.056"));
  });
});
