const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const FAR = 2n ** 40n;
const BPS = 10000n;
const DEAD = "0x000000000000000000000000000000000000dEaD";
const META = { image: "ipfs://img", description: "a test token", website: "https://x.y", twitter: "https://x.com/null", telegram: "" };

describe("null launchpad", function () {
  let pad, swap, owner, alice, bob, creator, feeTo, wallet2;
  const VIRTUAL = E("1.68");
  const OPEN_START = 8000n;
  const OPEN_DUR = 15n;
  const LAUNCH_FEE = E("0.001");
  const MIGRATION_FEE = E("0.01");

  async function launch({ value = LAUNCH_FEE, tax = 0, feeWallet = ethers.ZeroAddress } = {}) {
    const rc = await (await pad.connect(creator).createToken("Null Cat", "NCAT", META, tax, feeWallet, 0, { value })).wait();
    const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenLaunched");
    return ethers.getContractAt("NullToken", ev.args.token);
  }
  async function afterOpening() { await time.increase(Number(OPEN_DUR) + 1); }

  beforeEach(async () => {
    [owner, alice, bob, creator, feeTo, wallet2] = await ethers.getSigners();
    pad = await (await ethers.getContractFactory("NullLaunchpad")).deploy(VIRTUAL, OPEN_START, OPEN_DUR, LAUNCH_FEE, MIGRATION_FEE, feeTo.address);
    swap = await ethers.getContractAt("NullSwap", await pad.swap());
  });

  describe("launch", () => {
    it("mints 1B to the launchpad and stores metadata", async () => {
      const t = await launch();
      const a = await t.getAddress();
      expect(await t.totalSupply()).to.equal(E(1e9));
      expect(await t.balanceOf(await pad.getAddress())).to.equal(E(1e9));
      const v = await pad.getLaunch(a);
      expect(v.name).to.equal("Null Cat");
      expect(v.meta.description).to.equal("a test token");
      expect(v.meta.twitter).to.equal(META.twitter);
      expect(v.launch.feeWallet).to.equal(creator.address);
      expect(await pad.platformFeesAccrued()).to.equal(LAUNCH_FEE);
    });

    it("requires the launch fee", async () => {
      await expect(pad.connect(creator).createToken("A", "A", META, 0, ethers.ZeroAddress, 0, { value: 0 })).to.be.revertedWithCustomError(pad, "InsufficientLaunchFee");
    });

    it("caps creator tax so total fee <= 10%", async () => {
      await launch({ tax: 900 });
      await expect(launch({ tax: 901 })).to.be.revertedWithCustomError(pad, "BadParams");
    });

    it("opening price is virtualNative / 1B and graduation target ~4.2", async () => {
      const t = await launch();
      expect(await pad.priceOf(await t.getAddress())).to.equal(E("0.00000000168"));
      const target = await pad.graduationTarget();
      expect(target).to.be.gt(E("4.19"));
      expect(target).to.be.lt(E("4.2"));
    });

    it("creator opening buy is exempt from the opening tax", async () => {
      const t = await launch({ value: LAUNCH_FEE + E(1) });
      const got = await t.balanceOf(creator.address);
      const net = E(1) - E(1) / 100n; // only 1% trade fee
      expect(got).to.equal((E(1e9) * net) / (VIRTUAL + net));
    });
  });

  describe("opening tax", () => {
    it("is high at launch, decays linearly, reaches 0", async () => {
      const t = await launch();
      const a = await t.getAddress();
      const t0 = await pad.openingTaxBps(a);
      expect(t0).to.be.gt(7000n);
      await time.increase(7);
      const mid = await pad.openingTaxBps(a);
      expect(mid).to.be.lt(t0);
      expect(mid).to.be.gt(0n);
      await afterOpening();
      expect(await pad.openingTaxBps(a)).to.equal(0n);
    });

    it("snipers get far fewer tokens; sells are never opening-taxed", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      const sniped = await t.balanceOf(alice.address);
      const clean = (E(1e9) * (E(1) - E(1) / 100n)) / (VIRTUAL + E(1) - E(1) / 100n);
      expect(sniped * 2n).to.be.lt(clean); // ~1/3 of a clean buy
      // sell right away: only 1% fee
      await t.connect(alice).approve(a && (await pad.getAddress()), sniped);
      const q = await pad.quoteSell(a, sniped);
      const l = await pad.launches(a);
      const gross = (l.virtualNative * sniped) / (l.virtualToken + sniped);
      expect(q).to.equal(gross - gross / 100n);
    });
  });

  describe("trading & fees", () => {
    it("1% fee split 30% platform / 70% creator", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      const p0 = await pad.platformFeesAccrued();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
      expect(await pad.creatorFeesAccrued(a)).to.equal(E("0.007"));
    });

    it("creator tax goes fully to the creator", async () => {
      const t = await launch({ tax: 200 }); // 2%
      const a = await t.getAddress();
      await afterOpening();
      const p0 = await pad.platformFeesAccrued();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      expect((await pad.platformFeesAccrued()) - p0).to.equal(E("0.003"));
      expect(await pad.creatorFeesAccrued(a)).to.equal(E("0.027"));
    });

    it("quote matches execution; slippage + deadline protection", async () => {
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
      expect((await ethers.provider.getBalance(alice.address)) - b0 + rc.gasUsed * rc.gasPrice).to.equal(qs);
      expect(await pad.priceOf(a)).to.equal(E("0.00000000168"));
    });

    it("fee wallet can be changed by creator only, and claims go there", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(1) });
      await expect(pad.connect(alice).setFeeWallet(a, alice.address)).to.be.revertedWithCustomError(pad, "NotCreator");
      await pad.connect(creator).setFeeWallet(a, wallet2.address);
      const b0 = await ethers.provider.getBalance(wallet2.address);
      await pad.connect(bob).claimCreatorFees(a); // anyone can trigger
      expect((await ethers.provider.getBalance(wallet2.address)) - b0).to.equal(E("0.007"));
    });

    it("stays solvent after many round trips", async () => {
      const t = await launch({ tax: 300 });
      const a = await t.getAddress();
      for (let i = 0; i < 12; i++) {
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

  describe("graduation", () => {
    it("final buy is capped + refunded; pool seeded at final price; 71.4/~20.4/~8.2 split", async () => {
      const t = await launch();
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(2) });

      const b0 = await ethers.provider.getBalance(bob.address);
      const rc = await (await pad.connect(bob).buy(a, 0, FAR, { value: E(10) })).wait();
      const spent = b0 - (await ethers.provider.getBalance(bob.address)) - rc.gasUsed * rc.gasPrice;
      expect(spent).to.be.lt(E(3)); // refunded the excess

      const l = await pad.launches(a);
      expect(l.graduated).to.equal(true);
      expect(await pad.progressBps(a)).to.equal(BPS);
      expect((await t.balanceOf(alice.address)) + (await t.balanceOf(bob.address))).to.equal(E(714e6));

      const pool = await swap.pools(a);
      const locked = await t.balanceOf(DEAD);
      expect(pool.reserveNative).to.be.gt(E("4.17"));
      expect(pool.reserveNative).to.be.lt(E("4.2"));
      expect(pool.reserveToken).to.be.gt(E(203e6));
      expect(pool.reserveToken).to.be.lt(E(205e6));
      expect(locked).to.be.gt(E(80e6));
      expect(locked).to.be.lt(E(84e6));
      expect(pool.reserveToken + locked + E(714e6)).to.equal(E(1e9));
      expect(await t.balanceOf(await pad.getAddress())).to.equal(0n);

      const curvePrice = (l.virtualNative * E(1)) / l.virtualToken;
      const poolPrice = (pool.reserveNative * E(1)) / pool.reserveToken;
      const diff = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
      expect(diff * 100n).to.be.lt(curvePrice); // < 1% (migration fee)

      await expect(pad.connect(alice).buy(a, 0, FAR, { value: E(1) })).to.be.revertedWithCustomError(pad, "Graduated_");
      const bal = await ethers.provider.getBalance(await pad.getAddress());
      expect(bal).to.be.gte((await pad.platformFeesAccrued()) + (await pad.creatorFeesAccrued(a)));
    });

    it("pool trades with the same 1% (30/70) + creator tax and no LP fee", async () => {
      const t = await launch({ tax: 100 });
      const a = await t.getAddress();
      await afterOpening();
      await pad.connect(alice).buy(a, 0, FAR, { value: E(10) });
      expect((await pad.launches(a)).graduated).to.equal(true);

      const [q, fee] = await swap.quoteBuy(a, E(1));
      expect(fee).to.equal(E("0.02"));
      const pf0 = await swap.platformFeesAccrued();
      await swap.connect(bob).buy(a, q, FAR, { value: E(1) });
      expect((await swap.platformFeesAccrued()) - pf0).to.equal(E("0.003"));
      expect(await swap.creatorFeesAccrued(a)).to.equal(E("0.017"));

      await t.connect(bob).approve(await swap.getAddress(), q);
      const [qs] = await swap.quoteSell(a, q);
      await swap.connect(bob).sell(a, q, qs, FAR);
      expect(qs).to.be.gt(E("0.95"));

      // claims
      const w0 = await ethers.provider.getBalance(creator.address);
      const cf = await swap.creatorFeesAccrued(a);
      await swap.connect(bob).claimCreatorFees(a);
      expect((await ethers.provider.getBalance(creator.address)) - w0).to.equal(cf);
      const f0 = await ethers.provider.getBalance(feeTo.address);
      const pf = await swap.platformFeesAccrued();
      await swap.withdrawPlatformFees();
      expect((await ethers.provider.getBalance(feeTo.address)) - f0).to.equal(pf);
    });

    it("only the launchpad can create pools", async () => {
      await expect(swap.createPool(alice.address, 1, 0, { value: 1 })).to.be.revertedWithCustomError(swap, "NotLaunchpad");
    });

    it("getLaunches returns newest first", async () => {
      await launch(); const t2 = await launch();
      const list = await pad.getLaunches(0, 10);
      expect(list.length).to.equal(2);
      expect(list[0].token).to.equal(await t2.getAddress());
    });
  });

  describe("admin", () => {
    it("owner-only setters", async () => {
      await expect(pad.connect(alice).setLaunchFee(0)).to.be.revertedWithCustomError(pad, "OwnableUnauthorizedAccount");
      await pad.setLaunchFee(0);
      await pad.setPlatformFeeRecipient(bob.address);
      expect(await pad.platformFeeRecipient()).to.equal(bob.address);
      await expect(pad.setMigrationFee(E(1))).to.be.revertedWithCustomError(pad, "BadParams");
    });
  });
});
