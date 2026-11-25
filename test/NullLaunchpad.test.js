const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployUniswap } = require("./uniswap");

const E = (n) => ethers.parseEther(String(n));
const FAR = 2n ** 40n;
const BPS = 10000n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const META = { image: "ipfs://img", description: "a test token", website: "https://x.y", twitter: "https://x.com/null", telegram: "" };

describe("null launchpad (Uniswap V2 graduation)", function () {
  let pad, uni, owner, alice, bob, creator, feeTo, wallet2, mallory;
  const VIRTUAL = E("1.68");
  const OPEN_START = 8000n;
  const OPEN_DUR = 15n;
  const LAUNCH_FEE = E("0.001");
  const MIGRATION_FEE = E("0.01");

  async function launch({ value = LAUNCH_FEE, tax = 0, feeWallet = ethers.ZeroAddress, from = creator } = {}) {
    const rc = await (await pad.connect(from).createToken("Null Cat", "NCAT", META, tax, feeWallet, 0, { value })).wait();
    const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenLaunched");
    return ethers.getContractAt("NullToken", ev.args.token);
  }
  const afterOpening = () => time.increase(Number(OPEN_DUR) + 1);
  const wethAddr = () => uni.weth.getAddress();
  async function poolReserves(token) {
    const pair = uni.pairAt(await pad.pairOf(await token.getAddress()));
    const [r0, r1] = await pair.getReserves();
    return (await pair.token0()) === (await token.getAddress()) ? { rToken: r0, rNative: r1, pair } : { rToken: r1, rNative: r0, pair };
  }

  beforeEach(async () => {
    [owner, alice, bob, creator, feeTo, wallet2, mallory] = await ethers.getSigners();
    uni = await deployUniswap(owner);
    pad = await (await ethers.getContractFactory("NullLaunchpad")).deploy(
      await uni.factory.getAddress(), await wethAddr(), VIRTUAL, OPEN_START, OPEN_DUR, LAUNCH_FEE, MIGRATION_FEE, feeTo.address
    );
  });

  describe("launch", () => {
    it("mints 1B to the launchpad and stores metadata", async () => {
      const t = await launch();
      const a = await t.getAddress();
      expect(await t.totalSupply()).to.equal(E(1e9));
      expect(await t.balanceOf(await pad.getAddress())).to.equal(E(1e9));
      const v = await pad.getLaunch(a);
      expect(v.name).to.equal("Null Cat");
      expect(v.meta.twitter).to.equal(META.twitter);
      expect(v.launch.feeWallet).to.equal(creator.address);
      expect(v.graduationTarget).to.equal(await pad.graduationTarget());
      expect(await pad.platformFeesAccrued()).to.equal(LAUNCH_FEE);
    });

    it("requires the launch fee; caps creator tax at 9%", async () => {
      await expect(pad.connect(creator).createToken("A", "A", META, 0, ethers.ZeroAddress, 0, { value: 0 })).to.be.revertedWithCustomError(pad, "InsufficientLaunchFee");
      await launch({ tax: 900 });
      await expect(launch({ tax: 901 })).to.be.revertedWithCustomError(pad, "BadParams");
    });

    it("opening price is virtual / 1B; graduation target ~4.19", async () => {
      const t = await launch();
      expect(await pad.priceOf(await t.getAddress())).to.equal(E("0.00000000168"));
      const target = await pad.graduationTarget();
      expect(target).to.be.gt(E("4.19"));
      expect(target).to.be.lt(E("4.2"));
    });

    it("creator opening buy is exempt from the opening tax", async () => {
      const t = await launch({ value: LAUNCH_FEE + E(1) });
      const net = E(1) - E(1) / 100n;
      expect(await t.balanceOf(creator.address)).to.equal((E(1e9) * net) / (VIRTUAL + net));
    });
  });

  describe("opening tax", () => {
    it("decays linearly to 0; snipers get far less; sells untaxed", async () => {
      const t = await launch();
      const a = await t.getAddress();
      expect(await pad.openingTaxBps(a)).to.be.gt(7000n);
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      const sniped = await t.balanceOf(alice.address);
      const clean = (E(1e9) * (E(1) - E(1) / 100n)) / (VIRTUAL + E(1) - E(1) / 100n);
      expect(sniped * 2n).to.be.lt(clean);
      const l = await pad.launches(a);
      const gross = (l.virtualNative * sniped) / (l.virtualToken + sniped);
      expect(await pad.quoteSell(a, sniped)).to.equal(gross - gross / 100n);
      await afterOpening();
      expect(await pad.openingTaxBps(a)).to.equal(0n);
    });
  });

  describe("curve fees", () => {
    it("1% fee split 30/70; creator tax to creator; claims go to fee wallet", async () => {
      const t = await launch({ tax: 200 });
      const a = await t.getAddress();
      await afterOpening();
      const p0 = await pad.platformFeesAccrued();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
      expect(await pad.creatorFeesAccrued(a)).to.equal(E("0.027"));
      await expect(pad.connect(alice).setFeeWallet(a, alice.address)).to.be.revertedWithCustomError(pad, "NotCreator");
      await pad.connect(creator).setFeeWallet(a, wallet2.address);
      const b0 = await ethers.provider.getBalance(wallet2.address);
      await pad.connect(bob).claimCreatorFees(a);
      expect((await ethers.provider.getBalance(wallet2.address)) - b0).to.equal(E("0.027"));
    });

    it("quote == execution; slippage + deadline; round trip restores price", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      const q = await pad.quoteBuy(a, E(1));
      await expect(pad.connect(alice).buy(a, q + 1n, FAR, { value: E(1) })).to.be.revertedWithCustomError(pad, "Slippage");
      await expect(pad.connect(alice).buy(a, 0, 1, { value: E(1) })).to.be.revertedWithCustomError(pad, "Expired");
      await pad.connect(alice).buy(a, q, FAR, { value: E(1) });
      expect(await t.balanceOf(alice.address)).to.equal(q);
      await t.connect(alice).approve(await pad.getAddress(), q);
      const qs = await pad.quoteSell(a, q);
      const b0 = await ethers.provider.getBalance(alice.address);
      const rc = await (await pad.connect(alice).sell(a, q, qs, FAR)).wait();
      expect((await ethers.provider.getBalance(alice.address)) - b0 + rc.fee).to.equal(qs);
      expect(await pad.priceOf(a)).to.equal(E("0.00000000168"));
    });

    it("stays solvent after many round trips", async () => {
      const t = await launch({ tax: 300 });
      const a = await t.getAddress();
      for (let i = 0; i < 10; i++) {
        await pad.connect(alice).buy(a, 0, FAR, { value: E("0.3") });
        const bal = await t.balanceOf(alice.address);
        await t.connect(alice).approve(await pad.getAddress(), bal / 3n);
        await pad.connect(alice).sell(a, bal / 3n, 0, FAR);
      }
      const l = await pad.launches(a);
      const need = l.realNative + (await pad.platformFeesAccrued()) + (await pad.creatorFeesAccrued(a));
      expect(await ethers.provider.getBalance(await pad.getAddress())).to.be.gte(need);
    });
  });

  describe("graduation to Uniswap V2", () => {
    it("creates the pair, burns the LP, locks the rest, seeds at the curve price", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(2) });
      const b0 = await ethers.provider.getBalance(bob.address);
      const rc = await (await pad.connect(bob).buy(a, 0, FAR, { value: E(10) })).wait();
      expect(b0 - (await ethers.provider.getBalance(bob.address)) - rc.fee).to.be.lt(E(3)); // refunded

      const l = await pad.launches(a);
      expect(l.graduated).to.equal(true);
      expect(await t.graduated()).to.equal(true);
      const pairAddr = await pad.pairOf(a);
      expect(pairAddr).to.equal(await uni.factory.getPair(a, await wethAddr()));

      const { rToken, rNative, pair } = await poolReserves(t);
      expect(rNative).to.be.gt(E("4.17"));
      expect(rNative).to.be.lt(E("4.2"));
      expect(rToken).to.be.gt(E(203e6));
      expect(rToken).to.be.lt(E(205e6));
      const lockedTokens = await t.balanceOf(DEAD);
      expect(rToken + lockedTokens + E(714e6)).to.equal(E(1e9));
      expect(await t.balanceOf(await pad.getAddress())).to.equal(0n);

      // LP: everything except Uniswap's MINIMUM_LIQUIDITY (held by address(0)) is at 0xdEaD
      const lpTotal = await pair.totalSupply();
      expect(await pair.balanceOf(DEAD)).to.equal(lpTotal - 1000n);
      expect(await pair.balanceOf(await pad.getAddress())).to.equal(0n);

      const curvePrice = (l.virtualNative * E(1)) / l.virtualToken;
      const poolPrice = await pad.priceOf(a);
      const diff = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
      expect(diff * 100n).to.be.lt(curvePrice); // < 1% (the migration fee)

      await expect(pad.connect(alice).buy(a, 0, FAR, { value: E(1) })).to.be.revertedWithCustomError(pad, "Graduated_");
      expect(await ethers.provider.getBalance(await pad.getAddress())).to.be.gte((await pad.platformFeesAccrued()) + (await pad.creatorFeesAccrued(a)));
    });

    it("token trades freely on the Uniswap router after graduation", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(10) });
      const path = [await wethAddr(), a];
      const [, out] = await uni.router.getAmountsOut(E(1), path);
      await uni.router.connect(bob).swapExactETHForTokens(out, path, bob.address, FAR, { value: E(1) });
      expect(await t.balanceOf(bob.address)).to.equal(out);
      await t.connect(bob).approve(await uni.router.getAddress(), out);
      const back = [a, await wethAddr()];
      const [, ethOut] = await uni.router.getAmountsOut(out, back);
      await uni.router.connect(bob).swapExactTokensForETH(out, ethOut, back, bob.address, FAR);
      expect(ethOut).to.be.gt(E("0.99"));
      await t.connect(alice).transfer(bob.address, 1n); // plain transfers fine
    });

    it("migration fee is capped at 10% of the raise", async () => {
      await pad.setMigrationFee(E(100));
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      const p0 = await pad.platformFeesAccrued();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(10) });
      const { rNative } = await poolReserves(t);
      expect(rNative).to.be.gt(E("3.7")); // ~4.19 minus at most 10%
      expect((await pad.platformFeesAccrued()) - p0).to.be.lt(E("0.5"));
    });
  });

  describe("front-running the pool", () => {
    it("nobody can put tokens into the pair before graduation", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(mallory).buy(a, 0, FAR, { value: E("0.5") });
      await uni.factory.connect(mallory).createPair(a, await wethAddr());
      const pairAddr = await uni.factory.getPair(a, await wethAddr());
      await expect(t.connect(mallory).transfer(pairAddr, 1n)).to.be.revertedWithCustomError(t, "PoolLockedUntilGraduation");
      await t.connect(mallory).approve(await uni.router.getAddress(), E(1e6));
      await expect(uni.router.connect(mallory).addLiquidityETH(a, E(1e6), 0, 0, mallory.address, FAR, { value: E("0.01") })).to.be.reverted;
      await t.connect(mallory).transfer(bob.address, 1n); // normal transfers still work
    });

    it("pre-created pair with donated WETH cannot block or skew graduation", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await uni.factory.connect(mallory).createPair(a, await wethAddr());
      const pairAddr = await uni.factory.getPair(a, await wethAddr());
      await uni.weth.connect(mallory).deposit({ value: E("0.5") });
      await uni.weth.connect(mallory).transfer(pairAddr, E("0.5"));
      await uni.pairAt(pairAddr).sync();

      await pad.connect(alice).buy(a, 0, FAR, { value: E(10) });
      expect((await pad.launches(a)).graduated).to.equal(true);
      expect(await pad.pairOf(a)).to.equal(pairAddr);
      const { rNative } = await poolReserves(t);
      expect(rNative).to.be.gt(E("4.6")); // donation became locked liquidity
      const pair = uni.pairAt(pairAddr);
      expect(await pair.balanceOf(DEAD)).to.equal((await pair.totalSupply()) - 1000n);
    });
  });

  describe("admin", () => {
    it("owner-only setters; new virtual reserve applies to new launches only", async () => {
      await expect(pad.connect(alice).setVirtualNativeReserve(1)).to.be.revertedWithCustomError(pad, "OwnableUnauthorizedAccount");
      const old = await launch();
      await pad.setVirtualNativeReserve(E("0.00063")); // ~$1.2 virtual => ~$3 graduation
      const cheap = await launch();
      expect((await pad.launches(await old.getAddress())).initialVirtualNative).to.equal(VIRTUAL);
      expect((await pad.launches(await cheap.getAddress())).initialVirtualNative).to.equal(E("0.00063"));
      const target = await pad.graduationTargetOf(await cheap.getAddress());
      expect(target).to.be.gt(E("0.00157"));
      expect(target).to.be.lt(E("0.00158"));
      expect(await pad.graduationTargetOf(await old.getAddress())).to.be.gt(E("4.19"));
      await expect(pad.setVirtualNativeReserve(0)).to.be.revertedWithCustomError(pad, "BadParams");
      await pad.setPlatformFeeRecipient(bob.address);
      expect(await pad.platformFeeRecipient()).to.equal(bob.address);
    });

    it("a tiny-threshold launch graduates on Uniswap end-to-end", async () => {
      await pad.setVirtualNativeReserve(E("0.00063"));
      await pad.setMigrationFee(0);
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E("0.002") });
      expect((await pad.launches(a)).graduated).to.equal(true);
      const { rNative, rToken } = await poolReserves(t);
      expect(rNative).to.be.gt(E("0.00157"));
      expect(rToken).to.be.gt(E(203e6));
      const path = [await wethAddr(), a];
      const [, out] = await uni.router.getAmountsOut(E("0.0001"), path);
      await uni.router.connect(bob).swapExactETHForTokens(out, path, bob.address, FAR, { value: E("0.0001") });
      expect(await t.balanceOf(bob.address)).to.equal(out);
    });
  });
});
