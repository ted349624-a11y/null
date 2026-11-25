const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const WETH9 = require("@uniswap/v2-periphery/build/WETH9.json");

const E = (n) => ethers.parseEther(String(n));
const FAR = 2n ** 40n;
const BPS = 10000n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const META = { image: "", description: "nullswap test", website: "", twitter: "", telegram: "" };

describe("NullLaunchpad2 + NullSwap", function () {
  let pad, factory, router, weth, owner, alice, bob, carol, creator, feeTo, wallet2, mallory;
  const VIRTUAL = E("1.68");
  const OPEN_DUR = 15n;

  async function launch({ value = 0n, tax = 0, from = creator } = {}) {
    const rc = await (await pad.connect(from).createToken("Null Dog", "NDOG", META, tax, ethers.ZeroAddress, 0, { value })).wait();
    const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenLaunched");
    return ethers.getContractAt("NullToken2", ev.args.token);
  }
  const afterOpening = () => time.increase(Number(OPEN_DUR) + 1);
  async function graduate(t, tax = 0) {
    const a = await t.getAddress();
    await pad.connect(alice).buy(a, 0, FAR, { value: E(10) });
    expect((await pad.launches(a)).graduated).to.equal(true);
    return ethers.getContractAt("NullSwapPair", await pad.pairOf(a));
  }
  async function reserves(pair) {
    const [r0, r1] = await pair.getReserves();
    return (await pair.wethIsToken0()) ? { rW: r0, rT: r1 } : { rW: r1, rT: r0 };
  }
  async function ethDelta(signer, fn) {
    const b0 = await ethers.provider.getBalance(signer.address);
    const rc = await (await fn()).wait();
    return (await ethers.provider.getBalance(signer.address)) - b0 + rc.fee;
  }

  beforeEach(async () => {
    [owner, alice, bob, carol, creator, feeTo, wallet2, mallory] = await ethers.getSigners();
    weth = await new ethers.ContractFactory(WETH9.abi, WETH9.bytecode, owner).deploy();
    pad = await (await ethers.getContractFactory("NullLaunchpad2")).deploy(await weth.getAddress(), VIRTUAL, 8000, OPEN_DUR, 0, E("0.01"), feeTo.address);
    factory = await ethers.getContractAt("NullSwapFactory", await pad.swapFactory());
    router = await (await ethers.getContractFactory("NullSwapRouter")).deploy(await factory.getAddress(), await weth.getAddress());
  });

  describe("curve (unchanged economics)", () => {
    it("launch, metadata, creator record, opening price, target", async () => {
      const t = await launch({ value: E(1) });
      const a = await t.getAddress();
      const v = await pad.getLaunch(a);
      expect(v.name).to.equal("Null Dog");
      expect(v.creatorStats.launches).to.equal(1n);
      expect(v.creatorStats.graduations).to.equal(0n);
      expect(await t.balanceOf(creator.address)).to.equal((E(1e9) * (E(1) - E(1) / 100n)) / (VIRTUAL + E(1) - E(1) / 100n));
      const target = await pad.graduationTarget();
      expect(target).to.be.gt(E("4.19"));
      expect(target).to.be.lt(E("4.2"));
    });

    it("opening tax decays; 1% split 30/70; creator tax to creator", async () => {
      const t = await launch({ tax: 200 });
      const a = await t.getAddress();
      expect(await pad.openingTaxBps(a)).to.be.gt(7000n);
      await afterOpening();
      expect(await pad.openingTaxBps(a)).to.equal(0n);
      const p0 = await pad.platformFeesAccrued();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
      expect(await pad.creatorFeesAccrued(a)).to.equal(E("0.027"));
    });
  });

  describe("graduation into NullSwap", () => {
    it("pair created by our factory; LP fully locked; supply accounted; price continuous", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(2) });
      const pre = await pad.launches(a);
      const pair = await graduate(t);
      expect(await factory.pairOf(a)).to.equal(await pair.getAddress());
      expect(await factory.getPair(a, await weth.getAddress())).to.equal(await pair.getAddress());
      expect(await factory.getPair(await weth.getAddress(), a)).to.equal(await pair.getAddress());
      expect(await pair.feeBps()).to.equal(100n);
      expect(await pair.feeSink()).to.equal(await pad.getAddress());

      const { rW, rT } = await reserves(pair);
      expect(rW).to.be.gt(E("4.17"));
      expect(rT).to.be.gt(E(203e6));
      const locked = await t.balanceOf(DEAD);
      expect(rT + locked + E(714e6)).to.equal(E(1e9));
      expect(await t.balanceOf(await pad.getAddress())).to.equal(0n);
      expect(await pair.balanceOf(DEAD)).to.equal(await pair.totalSupply()); // all LP incl. MINIMUM_LIQUIDITY

      const l = await pad.launches(a);
      const curvePrice = (l.virtualNative * E(1)) / l.virtualToken;
      const poolPrice = await pad.priceOf(a);
      const diff = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
      expect(diff * 100n).to.be.lt(curvePrice);
      expect((await pad.getLaunch(a)).creatorStats.graduations).to.equal(1n);
      expect(pre.graduated).to.equal(false);
    });

    it("only the launchpad can create pairs", async () => {
      const t = await launch();
      await expect(factory.connect(mallory).createPair(await t.getAddress(), 100)).to.be.revertedWithCustomError(factory, "Forbidden");
    });

    it("donations to the predicted pair address are burned, not priced in", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(mallory).buy(a, 0, FAR, { value: E("0.5") });
      const predicted = await factory.pairFor(a);
      await weth.connect(mallory).deposit({ value: E(3) });
      await weth.connect(mallory).transfer(predicted, E(3));
      await t.connect(mallory).transfer(predicted, E(1e6));
      const pair = await graduate(t);
      expect(await pair.getAddress()).to.equal(predicted);
      const { rW, rT } = await reserves(pair);
      expect(rW).to.be.lt(E("4.2")); // the 3 WETH donation is not in the pool
      expect(await weth.balanceOf(DEAD)).to.equal(E(3));
      expect(await t.balanceOf(DEAD)).to.be.gte(E(1e6));
      expect(rT + (await t.balanceOf(DEAD)) + (await t.balanceOf(alice.address)) + (await t.balanceOf(mallory.address))).to.equal(E(1e9));
    });
  });

  describe("NullSwap trading", () => {
    it("router buy/sell: quote == execution; 1% fee split 30/70 in ETH", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await graduate(t);
      const c0 = await pad.creatorFeesAccrued(a);
      const p0 = await pad.platformFeesAccrued();

      const q = await router.quoteBuy(a, E(1));
      await router.connect(bob).swapExactETHForTokens(a, q, bob.address, FAR, { value: E(1) });
      expect(await t.balanceOf(bob.address)).to.equal(q);
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
      expect((await pad.creatorFeesAccrued(a)) - c0).to.equal(E("0.007"));

      await t.connect(bob).approve(await router.getAddress(), q);
      const qs = await router.quoteSell(a, q);
      const got = await ethDelta(bob, () => router.connect(bob).swapExactTokensForETH(a, q, qs, bob.address, FAR));
      expect(got).to.equal(qs);
      expect(qs).to.be.gt(E("0.97"));
      expect(qs).to.be.lt(E("0.99"));
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
      expect(await weth.balanceOf(await router.getAddress())).to.equal(0n);
    });

    it("creator tax keeps applying after graduation (fee = 1% + tax)", async () => {
      const t = await launch({ tax: 300 });
      const a = await t.getAddress();
      await afterOpening();
      const pair = await graduate(t);
      expect(await pair.feeBps()).to.equal(400n);
      const p0 = await pad.platformFeesAccrued();
      const c0 = await pad.creatorFeesAccrued(a);
      await router.connect(bob).swapExactETHForTokens(a, 0, bob.address, FAR, { value: E(1) });
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
      expect((await pad.creatorFeesAccrued(a)) - c0).to.equal(E("0.037"));
    });

    it("creator claims pool fees in ETH to the fee wallet", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await graduate(t);
      await router.connect(bob).swapExactETHForTokens(a, 0, bob.address, FAR, { value: E(2) });
      await pad.connect(creator).setFeeWallet(a, wallet2.address);
      const owed = await pad.creatorFeesAccrued(a);
      const b0 = await ethers.provider.getBalance(wallet2.address);
      await pad.connect(carol).claimCreatorFees(a);
      expect((await ethers.provider.getBalance(wallet2.address)) - b0).to.equal(owed);
      const f0 = await ethers.provider.getBalance(feeTo.address);
      const pf = await pad.platformFeesAccrued();
      await pad.withdrawPlatformFees();
      expect((await ethers.provider.getBalance(feeTo.address)) - f0).to.equal(pf);
    });

    it("direct pair swaps pay the fee too; skipping it breaks k", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      const pair = await graduate(t);
      const { rW, rT } = await reserves(pair);
      const wIs0 = await pair.wethIsToken0();
      const amountIn = E(1);
      // fee-free output: must revert
      const noFeeOut = rT - (rW * rT + rW + amountIn - 1n) / (rW + amountIn);
      await weth.connect(mallory).deposit({ value: amountIn });
      await weth.connect(mallory).transfer(await pair.getAddress(), amountIn);
      const outs = (o) => (wIs0 ? [0n, o] : [o, 0n]);
      await expect(pair.connect(mallory).swap(...outs(noFeeOut), mallory.address)).to.be.revertedWithCustomError(pair, "KInvariant");
      // fee-respecting output: succeeds and the fee reaches the launchpad
      const p0 = await pad.platformFeesAccrued();
      const okOut = await router.getAmountOutBuy(amountIn, rT, rW, 100);
      await pair.connect(mallory).swap(...outs(okOut), mallory.address);
      expect(await t.balanceOf(mallory.address)).to.equal(okOut);
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
    });

    it("onPoolFee only from the token's pair; launchpad rejects stray ETH", async () => {
      const t = await launch();
      await expect(pad.connect(mallory).onPoolFee(await t.getAddress(), 1)).to.be.revertedWithCustomError(pad, "OnlyPair");
      await expect(mallory.sendTransaction({ to: await pad.getAddress(), value: 1 })).to.be.revertedWithCustomError(pad, "OnlyWeth");
    });

    it("third parties can add and remove their own liquidity (no LP fee)", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      const pair = await graduate(t);
      const { rW, rT } = await reserves(pair);
      const tokAmt = E(1e6);
      const wAmt = (tokAmt * rW) / rT + 1n;
      await t.connect(alice).transfer(await pair.getAddress(), tokAmt);
      await weth.connect(alice).deposit({ value: wAmt });
      await weth.connect(alice).transfer(await pair.getAddress(), wAmt);
      await pair.mint(alice.address);
      const lp = await pair.balanceOf(alice.address);
      expect(lp).to.be.gt(0n);
      await pair.connect(alice).transfer(await pair.getAddress(), lp);
      await pair.burn(alice.address);
      expect(await pair.balanceOf(alice.address)).to.equal(0n);
    });
  });

  describe("invariants under random trading", () => {
    it("k never decreases, fees always backed, router holds nothing", async function () {
      this.timeout(120000);
      const t = await launch({ tax: 150 });
      const a = await t.getAddress();
      await afterOpening();
      const pair = await graduate(t);
      const traders = [alice, bob, carol, mallory];
      for (const tr of traders) await t.connect(tr).approve(await router.getAddress(), ethers.MaxUint256);
      let seed = 12345n;
      const rnd = (m) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % 2n ** 64n; return seed % m; };
      let { rW, rT } = await reserves(pair);
      let k = rW * rT;
      for (let i = 0; i < 40; i++) {
        const tr = traders[Number(rnd(4n))];
        if (rnd(2n) === 0n) {
          const v = E("0.01") + rnd(E(1));
          const q = await router.quoteBuy(a, v);
          await router.connect(tr).swapExactETHForTokens(a, q, tr.address, FAR, { value: v });
        } else {
          const bal = await t.balanceOf(tr.address);
          if (bal === 0n) continue;
          const amt = bal / (1n + rnd(4n));
          const q = await router.quoteSell(a, amt);
          if (q === 0n) continue;
          await router.connect(tr).swapExactTokensForETH(a, amt, q, tr.address, FAR);
        }
        ({ rW, rT } = await reserves(pair));
        expect(rW * rT).to.be.gte(k);
        k = rW * rT;
      }
      const owed = (await pad.platformFeesAccrued()) + (await pad.creatorFeesAccrued(a));
      expect(await ethers.provider.getBalance(await pad.getAddress())).to.be.gte(owed);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
      expect(await weth.balanceOf(await router.getAddress())).to.equal(0n);
      expect(await weth.balanceOf(await pad.getAddress())).to.equal(0n);
    });
  });

  describe("admin", () => {
    it("owner-only params; new launches only", async () => {
      await expect(pad.connect(alice).setVirtualNativeReserve(1)).to.be.revertedWithCustomError(pad, "OwnableUnauthorizedAccount");
      const old = await launch();
      await pad.setVirtualNativeReserve(E("0.0011"));
      const cheap = await launch();
      expect((await pad.launches(await old.getAddress())).initialVirtualNative).to.equal(VIRTUAL);
      expect((await pad.launches(await cheap.getAddress())).initialVirtualNative).to.equal(E("0.0011"));
      // a cheap launch graduates and trades on NullSwap end to end
      await afterOpening();
      const ca = await cheap.getAddress();
      await pad.connect(alice).buy(ca, 0, FAR, { value: E("0.01") });
      expect((await pad.launches(ca)).graduated).to.equal(true);
      const q = await router.quoteBuy(ca, E("0.0001"));
      await router.connect(bob).swapExactETHForTokens(ca, q, bob.address, FAR, { value: E("0.0001") });
      expect(await cheap.balanceOf(bob.address)).to.equal(q);
    });
  });
});
