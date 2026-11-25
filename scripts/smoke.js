// End-to-end smoke test against a live deployment (e.g. Zero testnet).
//   npm run smoke:testnet               -> launch, buy, sell, claim fees
//   GRADUATE=1 npm run smoke:testnet    -> also buys out the curve, checks the Uniswap V2 pool and trades on it
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
  const ROUTER_ABI = [
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  ];
  const PAIR_ABI = ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)", "function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
  const router = new ethers.Contract(dep.uniswap.router, ROUTER_ABI, me);
  const launchFee = await pad.launchFee();
  const target = await pad.graduationTarget();
  info(`launch fee ${fmt(launchFee)} | graduation target ~${fmt(target)}`);

  // 1. launch with a small opening buy (exempt from opening tax)
  const cap = ethers.parseEther(process.env.SMOKE_AMOUNT || "0.01");
  const unit = startBal / 200n > cap ? cap : startBal / 200n;
  const meta = { image: "", description: "smoke test", website: "", twitter: "", telegram: "" };
  const rc = await (await pad.createToken(process.env.SMOKE_NAME || "Smoke Test", process.env.SMOKE_SYMBOL || "SMOKE", meta, 100, ethers.ZeroAddress, 0, { value: launchFee + unit })).wait();
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
  const b1 = await ethers.provider.getBalance(me.address, src.blockNumber);
  // OP-stack chains (Base) charge an extra L1 data fee that is not part of gasUsed * gasPrice.
  const raw = await ethers.provider.send("eth_getTransactionReceipt", [src.hash]);
  const l1Fee = raw.l1Fee ? BigInt(raw.l1Fee) : 0n;
  check(b1 + src.fee + l1Fee - b0 === qs, "sell paid out the quoted amount");
  const tradeEv = src.logs.map((l) => { try { return pad.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "Trade");
  check(!!tradeEv && tradeEv.args.nativeAmount === qs, "Trade event emitted with the paid amount");

  // 5. trade events readable (frontend "recent trades")
  // eth_getLogs is an RPC feature, not a contract one: public RPCs often restrict it, so only warn.
  try {
    const q = ethers.provider.getLogs({ address: dep.launchpad, topics: [pad.interface.getEvent("Trade").topicHash, ethers.zeroPadValue(tokenAddr, 32)], fromBlock: rc.blockNumber, toBlock: "latest" });
    const logs = await Promise.race([q, sleep(20000).then(() => { throw new Error("timed out"); })]);
    check(logs.length >= 3, `Trade events readable via eth_getLogs (${logs.length})`);
  } catch (e) { console.log(`  WARN  eth_getLogs not available on this RPC (${e.shortMessage || e.message}); the frontend falls back to the wallet RPC`); }

  // 6. creator fees
  const cf = await pad.creatorFeesAccrued(tokenAddr);
  check(cf > 0n, `creator fees accrued ${fmt(cf)}`);
  await (await pad.claimCreatorFees(tokenAddr)).wait();
  check((await pad.creatorFeesAccrued(tokenAddr)) === 0n, "creator fees claimed");

  // 7. optional: graduation into Uniswap V2 + trading there
  if (process.env.GRADUATE === "1") {
    const l = await pad.launches(tokenAddr);
    const tgt = await pad.graduationTargetOf(tokenAddr);
    const need = ((tgt - l.realNative) * 105n) / 100n + tgt / 50n;
    const bal = await ethers.provider.getBalance(me.address);
    if (bal < need + ethers.parseEther("0.0003")) {
      info(`skipping graduation: need ~${fmt(need)} but balance is ${fmt(bal)}. Lower the virtual reserve for test launches.`);
    } else {
      const grc = await (await pad.buy(tokenAddr, 0, FAR(), { value: need })).wait();
      info(`graduating buy gas used ${grc.gasUsed}`);
      check((await pad.launches(tokenAddr)).graduated && (await token.graduated()), "curve sold out and graduated");
      const pairAddr = await pad.pairOf(tokenAddr);
      const pair = new ethers.Contract(pairAddr, PAIR_ABI, ethers.provider);
      const [r0, r1] = await pair.getReserves();
      const [rTok, rNat] = (await pair.token0()) === tokenAddr ? [r0, r1] : [r1, r0];
      check(rNat > 0n && rTok > 0n, `Uniswap V2 pair ${pairAddr}: ${fmt(rNat)} WETH / ${ethers.formatUnits(rTok, 18)} tokens`);
      const lpTotal = await pair.totalSupply();
      check((await pair.balanceOf("0x000000000000000000000000000000000000dEaD")) === lpTotal - 1000n, "LP tokens burned to 0xdEaD (liquidity locked)");
      check((await token.balanceOf(dep.launchpad)) === 0n, "launchpad holds no leftover tokens");

      const path = [dep.uniswap.weth, tokenAddr];
      const [, out] = await router.getAmountsOut(unit, path);
      const t0 = await token.balanceOf(me.address);
      await (await router.swapExactETHForTokens(out, path, me.address, FAR(), { value: unit })).wait();
      check((await token.balanceOf(me.address)) - t0 === out, "Uniswap buy matched getAmountsOut");
      const sellAmt = out / 2n;
      await (await token.approve(dep.uniswap.router, sellAmt)).wait();
      const [, ethOut] = await router.getAmountsOut(sellAmt, [tokenAddr, dep.uniswap.weth]);
      await (await router.swapExactTokensForETH(sellAmt, ethOut, [tokenAddr, dep.uniswap.weth], me.address, FAR())).wait();
      check(ethOut > 0n, `Uniswap sell returned ${fmt(ethOut)}`);
    }
  }

  const endBal = await ethers.provider.getBalance(me.address);
  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`} | spent ${fmt(startBal - endBal)} (incl. gas)\n`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(`\n  ERROR ${e.shortMessage || e.message}\n`); process.exit(1); });
