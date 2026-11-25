// End-to-end smoke test against a live deployment (e.g. Zero testnet).
//   npm run smoke:testnet               -> launch, buy, sell, claim fees
//   GRADUATE=1 npm run smoke:testnet    -> also buys out the curve and trades on the pool
//
// Reads the deployed addresses from deployments/<network>.json.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const ok = (m) => console.log(`  PASS  ${m}`);
const info = (m) => console.log(`        ${m}`);
let failed = 0;
const check = (cond, m) => { if (cond) ok(m); else { failed++; console.log(`  FAIL  ${m}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAR = () => BigInt(Math.floor(Date.now() / 1000) + 600);

async function main() {
  const file = path.join(__dirname, `../deployments/${network.name}.json`);
  if (!fs.existsSync(file)) throw new Error(`No deployment found at ${file}. Run the deploy script first.`);
  const dep = JSON.parse(fs.readFileSync(file));
  const [me] = await ethers.getSigners();
  const fmt = ethers.formatEther;

  console.log(`\nnull smoke test on ${network.name}`);
  const { chainId } = await ethers.provider.getNetwork();
  const startBal = await ethers.provider.getBalance(me.address);
  info(`chainId ${chainId} | block ${await ethers.provider.getBlockNumber()} | wallet ${me.address} | balance ${fmt(startBal)}`);
  check(Number(chainId) === dep.chainId, "connected to the deployment's chain");

  const pad = await ethers.getContractAt("NullLaunchpad", dep.launchpad);
  const swap = await ethers.getContractAt("NullSwap", dep.swap);
  const launchFee = await pad.launchFee();
  const target = await pad.graduationTarget();
  info(`launch fee ${fmt(launchFee)} | graduation target ~${fmt(target)}`);

  // 1. launch with a small opening buy (exempt from opening tax)
  const unit = startBal / 200n > ethers.parseEther("0.01") ? ethers.parseEther("0.01") : startBal / 200n;
  const meta = { image: "", description: "smoke test", website: "", twitter: "", telegram: "" };
  const rc = await (await pad.createToken("Smoke Test", "SMOKE", meta, 100, ethers.ZeroAddress, 0, { value: launchFee + unit })).wait();
  const ev = rc.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "TokenLaunched");
  check(!!ev, `token launched (gas used ${rc.gasUsed})`);
  const tokenAddr = ev.args.token;
  const token = await ethers.getContractAt("NullToken", tokenAddr);
  info(`token ${tokenAddr}`);
  const got = await token.balanceOf(me.address);
  check(got > 0n, `opening buy received ${ethers.formatUnits(got, 18)} SMOKE`);

  // 2. opening tax decays to zero on the live chain clock
  const ot0 = await pad.openingTaxBps(tokenAddr);
  info(`opening tax right after launch: ${Number(ot0) / 100}%`);
  const dur = Number(await pad.openingTaxDuration());
  if (["localhost", "hardhat"].includes(network.name)) {
    // local dev chains only advance time when a block is mined
    await network.provider.send("evm_increaseTime", [dur + 1]);
    await network.provider.send("evm_mine");
  }
  let ot = ot0;
  for (let i = 0; i < dur + 30 && ot > 0n; i++) { await sleep(1000); ot = await pad.openingTaxBps(tokenAddr); }
  check(ot === 0n, "opening tax reached 0 on chain time");

  // 3. buy at quote
  const q = await pad.quoteBuy(tokenAddr, unit);
  await (await pad.buy(tokenAddr, q, FAR(), { value: unit })).wait();
  const afterBuy = await token.balanceOf(me.address);
  check(afterBuy - got === q, "buy matched the quote exactly");

  // 4. sell half at quote
  const half = afterBuy / 2n;
  await (await token.approve(dep.launchpad, ethers.MaxUint256)).wait();
  const qs = await pad.quoteSell(tokenAddr, half);
  const b0 = await ethers.provider.getBalance(me.address);
  const src = await (await pad.sell(tokenAddr, half, qs, FAR())).wait();
  const b1 = await ethers.provider.getBalance(me.address);
  check(b1 + src.fee - b0 === qs, "sell paid out the quoted amount");

  // 5. trade events readable (frontend "recent trades")
  try {
    const logs = await ethers.provider.getLogs({ address: dep.launchpad, topics: [pad.interface.getEvent("Trade").topicHash, ethers.zeroPadValue(tokenAddr, 32)], fromBlock: rc.blockNumber, toBlock: "latest" });
    check(logs.length >= 3, `Trade events readable via eth_getLogs (${logs.length})`);
  } catch (e) { failed++; console.log(`  FAIL  eth_getLogs: ${e.shortMessage || e.message}`); }

  // 6. creator fees
  const cf = await pad.creatorFeesAccrued(tokenAddr);
  check(cf > 0n, `creator fees accrued ${fmt(cf)}`);
  await (await pad.claimCreatorFees(tokenAddr)).wait();
  check((await pad.creatorFeesAccrued(tokenAddr)) === 0n, "creator fees claimed");

  // 7. optional: graduation + pool trading
  if (process.env.GRADUATE === "1") {
    const l = await pad.launches(tokenAddr);
    const need = ((target - l.realNative) * 105n) / 100n + ethers.parseEther("0.001");
    const bal = await ethers.provider.getBalance(me.address);
    if (bal < need + ethers.parseEther("0.01")) {
      info(`skipping graduation: need ~${fmt(need)} but balance is ${fmt(bal)}. Redeploy with a smaller VIRTUAL_NATIVE for testnet.`);
    } else {
      await (await pad.buy(tokenAddr, 0, FAR(), { value: need })).wait();
      check((await pad.launches(tokenAddr)).graduated, "curve sold out and graduated");
      const pool = await swap.pools(tokenAddr);
      check(pool.exists && pool.reserveNative > 0n, `pool created: ${fmt(pool.reserveNative)} native / ${ethers.formatUnits(pool.reserveToken, 18)} tokens`);
      const [pq] = await swap.quoteBuy(tokenAddr, unit);
      const t0 = await token.balanceOf(me.address);
      await (await swap.buy(tokenAddr, pq, FAR(), { value: unit })).wait();
      check((await token.balanceOf(me.address)) - t0 === pq, "pool buy matched the quote");
    }
  }

  const endBal = await ethers.provider.getBalance(me.address);
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} | spent ${fmt(startBal - endBal)} (incl. gas)\n`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(`\n  ERROR ${e.shortMessage || e.message}\n`); process.exit(1); });
