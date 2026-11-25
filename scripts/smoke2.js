// Live end-to-end check of a nullswap-generation deployment (deployments/<network>-v2.json):
//   npm run smoke:testnet            launch, opening tax, curve buy/sell, creator fees
//   GRADUATE=1 npm run smoke:testnet also graduates into nullswap, trades there and checks pool fees
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

let failed = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const info = (m) => console.log(`        ${m}`);
const check = (c, m) => { if (c) ok(m); else { failed++; console.log(`  FAIL  ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAR = () => BigInt(Math.floor(Date.now() / 1000) + 600);
const DEAD = "0x000000000000000000000000000000000000dEaD";

async function paid(rc) {
  // OP-stack chains (Base) add an L1 data fee on top of gasUsed * gasPrice.
  const raw = await ethers.provider.send("eth_getTransactionReceipt", [rc.hash]);
  return rc.fee + (raw.l1Fee ? BigInt(raw.l1Fee) : 0n);
}

async function main() {
  const file = path.join(__dirname, `../deployments/${network.name}-v2.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment at ${file}. Run scripts/deploy2.js first.`);
  const dep = JSON.parse(fs.readFileSync(file));
  const [me] = await ethers.getSigners();
  const fmt = ethers.formatEther;
  const start = await ethers.provider.getBalance(me.address);
  console.log(`\nnull v2 smoke test on ${network.name} | wallet ${me.address} | balance ${fmt(start)}`);

  const pad = await ethers.getContractAt("NullLaunchpad2", dep.launchpad);
  const router = await ethers.getContractAt("NullSwapRouter", dep.swapRouter);
  const cap = ethers.parseEther(process.env.SMOKE_AMOUNT || "0.01");
  const unit = start / 100n > cap ? cap : start / 100n;

  // 1. launch with an opening buy
  const meta = { image: "", description: "smoke test", website: "", twitter: "", telegram: "" };
  const lf = await pad.launchFee();
  const rc = await (await pad.createToken(process.env.SMOKE_NAME || "Smoke Test", process.env.SMOKE_SYMBOL || "SMOKE", meta, 100, ethers.ZeroAddress, 0, { value: lf + unit })).wait();
  const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenLaunched");
  check(!!ev, `token launched (gas ${rc.gasUsed})`);
  const a = ev.args.token;
  const t = await ethers.getContractAt("NullToken2", a);
  info(`token ${a}`);
  check((await t.balanceOf(me.address)) > 0n, "opening buy received tokens");

  // 2. opening tax decays on chain time
  const dur = Number(await pad.openingTaxDuration());
  if (["localhost", "hardhat"].includes(network.name)) { await network.provider.send("evm_increaseTime", [dur + 1]); await network.provider.send("evm_mine"); }
  let ot = await pad.openingTaxBps(a);
  info(`opening tax now ${Number(ot) / 100}%`);
  for (let i = 0; i < dur + 30 && ot > 0n; i++) { await sleep(1000); ot = await pad.openingTaxBps(a); }
  check(ot === 0n, "opening tax reached 0");

  // 3. curve buy + sell at quote
  const before = await t.balanceOf(me.address);
  const q = await pad.quoteBuy(a, unit);
  await (await pad.buy(a, q, FAR(), { value: unit })).wait();
  check((await t.balanceOf(me.address)) - before === q, "curve buy matched the quote");
  await (await t.approve(dep.launchpad, ethers.MaxUint256)).wait();
  const half = (await t.balanceOf(me.address)) / 2n;
  const qs = await pad.quoteSell(a, half);
  const b0 = await ethers.provider.getBalance(me.address);
  const src = await (await pad.sell(a, half, qs, FAR())).wait();
  const b1 = await ethers.provider.getBalance(me.address, src.blockNumber);
  check(b1 + (await paid(src)) - b0 === qs, "curve sell paid the quoted amount");

  // 4. creator fees
  check((await pad.creatorFeesAccrued(a)) > 0n, "creator fees accrued");
  await (await pad.claimCreatorFees(a)).wait();
  check((await pad.creatorFeesAccrued(a)) === 0n, "creator fees claimed");

  // 5. graduation into nullswap + trading there
  if (process.env.GRADUATE === "1") {
    const l = await pad.launches(a);
    const tgt = await pad.graduationTargetOf(a);
    const need = ((tgt - l.realNative) * 105n) / 100n + tgt / 50n;
    const bal = await ethers.provider.getBalance(me.address);
    if (bal < need + unit * 3n) {
      info(`skipping graduation: need ~${fmt(need)}, balance ${fmt(bal)}. Lower the virtual reserve for test launches.`);
    } else {
      const g = await (await pad.buy(a, 0, FAR(), { value: need })).wait();
      info(`graduating buy gas ${g.gasUsed}`);
      check((await pad.launches(a)).graduated, "curve sold out and graduated");
      const pair = await ethers.getContractAt("NullSwapPair", await pad.pairOf(a));
      const [r0, r1] = await pair.getReserves();
      const [rW, rT] = (await pair.wethIsToken0()) ? [r0, r1] : [r1, r0];
      check(rW > 0n && rT > 0n, `nullswap pair ${await pair.getAddress()}: ${fmt(rW)} WETH / ${ethers.formatUnits(rT, 18)} tokens`);
      check((await pair.balanceOf(DEAD)) === (await pair.totalSupply()), "all LP locked at 0xdEaD");
      check((await t.balanceOf(dep.launchpad)) === 0n, "launchpad holds no leftover tokens");

      const c0 = await pad.creatorFeesAccrued(a);
      const p0 = await pad.platformFeesAccrued();
      const qb = await router.quoteBuy(a, unit);
      const tb = await t.balanceOf(me.address);
      await (await router.swapExactETHForTokens(a, qb, me.address, FAR(), { value: unit })).wait();
      check((await t.balanceOf(me.address)) - tb === qb, "nullswap buy matched the quote");
      const feeBps = BigInt(await pair.feeBps());
      const fee = (unit * feeBps) / 10000n;
      const platform = (fee * 100n * 3000n) / (feeBps * 10000n);
      check((await pad.platformFeesAccrued()) - p0 === platform && (await pad.creatorFeesAccrued(a)) - c0 === fee - platform, `pool fee ${fmt(fee)} split ${fmt(platform)} platform / ${fmt(fee - platform)} creator`);

      const sellAmt = qb / 2n;
      await (await t.approve(dep.swapRouter, sellAmt)).wait();
      const qn = await router.quoteSell(a, sellAmt);
      const s0 = await ethers.provider.getBalance(me.address);
      const sr = await (await router.swapExactTokensForETH(a, sellAmt, qn, me.address, FAR())).wait();
      const s1 = await ethers.provider.getBalance(me.address, sr.blockNumber);
      check(s1 + (await paid(sr)) - s0 === qn, "nullswap sell paid the quoted amount");
      await (await pad.claimCreatorFees(a)).wait();
      check((await pad.creatorFeesAccrued(a)) === 0n, "creator claimed pool fees");
    }
  }

  const end = await ethers.provider.getBalance(me.address);
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} | spent ${fmt(start - end)} (incl. gas)\n`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(`\n  ERROR ${e.shortMessage || e.message}\n`); process.exit(1); });
