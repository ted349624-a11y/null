// Deploy the nullswap generation (NullLaunchpad2 + NullSwap factory/router):
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy2.js --network baseSepolia
//
// Optional env (defaults in brackets):
//   VIRTUAL_NATIVE      [1.68]   virtual native reserve -> graduates at ~2.5x this
//   OPENING_TAX_BPS     [8000]   anti-snipe buy tax at t=0
//   OPENING_TAX_SECONDS [15]
//   LAUNCH_FEE          [0]
//   MIGRATION_FEE       [0.01]   capped at 10% of the raise
//   FEE_RECIPIENT       [deployer]
//   OWNER               [deployer]
//   WETH                [chain default]  wrapped native token; on chains without one set DEPLOY_WETH=1
//   CONFIRM_MAINNET=1   required on mainnets
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const CHAINS = {
  baseSepolia: {
    slot: "testnet", name: "Base Sepolia", symbol: "ETH", explorer: "https://sepolia.basescan.org",
    weth: "0x4200000000000000000000000000000000000006",
    quickBuys: ["0.001", "0.005", "0.01", "0.02"],
    logApi: "https://base-sepolia.blockscout.com/api",
    faucets: [{"name": "Alchemy", "url": "https://www.alchemy.com/faucets/base-sepolia"}, {"name": "QuickNode", "url": "https://faucet.quicknode.com/base/sepolia", "note": "needs a small mainnet balance"}],
  },
  base: { slot: "mainnet", name: "Base", symbol: "ETH", explorer: "https://basescan.org", logApi: "https://base.blockscout.com/api", weth: "0x4200000000000000000000000000000000000006", mainnet: true, quickBuys: ["0.001", "0.005", "0.01", "0.05"] },
  zero: { slot: "zero", name: "Zero", symbol: "ZRO", explorer: process.env.EXPLORER_URL || "https://explorer.zero.layerzero.network", mainnet: true },
  zeroTestnet: { slot: "zeroTestnet", name: "Zero Testnet", symbol: "ZRO", explorer: process.env.EXPLORER_URL || "" },
  localhost: { slot: "testnet", name: "Localhost", symbol: "ETH", explorer: "", local: true },
  hardhat: { slot: "testnet", name: "Hardhat", symbol: "ETH", explorer: "", local: true },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY.");
  const chain = CHAINS[network.name] || { slot: network.name, name: network.name, symbol: "ETH", explorer: "" };
  if (chain.mainnet && process.env.CONFIRM_MAINNET !== "1") throw new Error(`${network.name} is a mainnet. Re-run with CONFIRM_MAINNET=1.`);

  const p = {
    virtualNative: ethers.parseEther(process.env.VIRTUAL_NATIVE || "1.68"),
    openingTaxBps: BigInt(process.env.OPENING_TAX_BPS || "8000"),
    openingTaxSeconds: BigInt(process.env.OPENING_TAX_SECONDS || "15"),
    launchFee: ethers.parseEther(process.env.LAUNCH_FEE || "0"),
    migrationFee: ethers.parseEther(process.env.MIGRATION_FEE || "0.01"),
    feeRecipient: process.env.FEE_RECIPIENT || deployer.address,
  };
  const owner = process.env.OWNER || deployer.address;
  if (!ethers.isAddress(owner) || !ethers.isAddress(p.feeRecipient)) throw new Error("OWNER / FEE_RECIPIENT must be valid addresses.");

  let weth = process.env.WETH || chain.weth;
  if (!weth && (chain.local || process.env.DEPLOY_WETH === "1")) {
    const W = require("@uniswap/v2-periphery/build/WETH9.json");
    const w = await new ethers.ContractFactory(W.abi, W.bytecode, deployer).deploy();
    await w.waitForDeployment();
    weth = await w.getAddress();
    console.log("WETH9 deployed:", weth);
  }
  if (!weth || !ethers.isAddress(weth)) throw new Error("No wrapped native token. Set WETH or DEPLOY_WETH=1.");

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Network ${network.name} | deployer ${deployer.address} | balance ${ethers.formatEther(bal)} ${chain.symbol}`);

  const pad = await (await ethers.getContractFactory("NullLaunchpad2")).deploy(
    weth, p.virtualNative, p.openingTaxBps, p.openingTaxSeconds, p.launchFee, p.migrationFee, p.feeRecipient
  );
  await pad.waitForDeployment();
  const launchpad = await pad.getAddress();
  const factory = await pad.swapFactory();
  const router = await (await ethers.getContractFactory("NullSwapRouter")).deploy(factory, weth);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await pad.transferOwnership(owner)).wait();
    console.log(`Ownership transferred to ${owner}`);
  }
  const { chainId } = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlockNumber();

  const out = {
    version: "v2", network: network.name, chainId: Number(chainId), launchpad, swapFactory: factory, swapRouter: routerAddr, weth,
    deployBlock: block, owner: await pad.owner(),
    params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.toString()])),
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, `../deployments/${network.name}-v2.json`), JSON.stringify(out, null, 2));

  const cfg = {
    version: "v2", chainId: Number(chainId), chainName: chain.name, rpcUrl: network.config.url || "http://127.0.0.1:8545",
    nativeSymbol: chain.symbol, explorer: chain.explorer, quickBuys: chain.quickBuys || ["0.1", "0.5", "1", "2"],
    logRpcUrls: chain.logRpcUrls || [], logApi: chain.logApi || "", links: chain.links || {}, faucets: chain.faucets || [],
    testnet: !chain.mainnet && !process.env.CONFIG_SLOT, launchpad, swapRouter: routerAddr, swapFactory: factory, weth, deployBlock: block,
  };
  const slot = process.env.CONFIG_SLOT || chain.slot; // e.g. CONFIG_SLOT=mainnet to rehearse the mainnet site locally
  const file = path.join(__dirname, `../frontend/config.${slot}.js`);
  fs.writeFileSync(file, `window.NULL_CONFIGS = window.NULL_CONFIGS || {};\nwindow.NULL_CONFIGS[${JSON.stringify(slot)}] = ${JSON.stringify(cfg, null, 2)};\n`);
  console.log(out);
  console.log(`${path.relative(process.cwd(), file)} written.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
