// Deploy null:
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network <network>
//
// Optional env (defaults in brackets):
//   VIRTUAL_NATIVE      [1.68]   virtual native reserve -> curve graduates at ~2.5x this (~4.19)
//   OPENING_TAX_BPS     [8000]   anti-snipe buy tax at t=0 (80%)
//   OPENING_TAX_SECONDS [15]     seconds until the opening tax reaches 0
//   LAUNCH_FEE          [0]      native fee to create a token
//   MIGRATION_FEE       [0.01]   native taken from the curve at graduation (capped at 10% of the raise)
//   FEE_RECIPIENT       [deployer]
//   OWNER               [deployer]  ownership is transferred here right after deployment
//   UNISWAP_FACTORY / UNISWAP_ROUTER / WETH   required on networks without built-in addresses
//   CONFIRM_MAINNET=1   required on mainnet networks (base, zero)
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const CHAINS = {
  base: {
    name: "Base", symbol: "ETH", explorer: "https://basescan.org", mainnet: true,
    uniswap: { factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6", router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", weth: "0x4200000000000000000000000000000000000006" },
    links: { uniswap: "https://app.uniswap.org/swap?chain=base&inputCurrency=ETH&outputCurrency=", dexscreener: "https://dexscreener.com/base/" },
    quickBuys: ["0.001", "0.005", "0.01", "0.05"],
    logRpcUrls: ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://base.llamarpc.com"],
  },
  zeroTestnet: { name: "Zero Testnet", symbol: "ZRO", explorer: process.env.EXPLORER_URL || "" },
  zero: { name: "Zero", symbol: "ZRO", explorer: process.env.EXPLORER_URL || "https://explorer.zero.layerzero.network", mainnet: true },
  localhost: { name: "Localhost", symbol: "ETH", explorer: "", local: true },
  hardhat: { name: "Hardhat", symbol: "ETH", explorer: "", local: true },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY.");
  const chain = CHAINS[network.name] || { name: network.name, symbol: "ETH", explorer: "" };
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

  // Uniswap V2: built-in addresses, env overrides, or a fresh local deployment.
  let uni = chain.uniswap;
  if (process.env.UNISWAP_FACTORY) uni = { factory: process.env.UNISWAP_FACTORY, router: process.env.UNISWAP_ROUTER, weth: process.env.WETH };
  if (!uni && chain.local) {
    const { deployUniswap } = require("../test/uniswap");
    const d = await deployUniswap(deployer);
    uni = { factory: await d.factory.getAddress(), router: await d.router.getAddress(), weth: await d.weth.getAddress() };
    console.log("Local Uniswap V2 deployed:", uni);
  }
  if (!uni || ![uni.factory, uni.router, uni.weth].every((a) => a && ethers.isAddress(a))) {
    throw new Error("No Uniswap V2 addresses for this network. Set UNISWAP_FACTORY, UNISWAP_ROUTER and WETH.");
  }

  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Network ${network.name} | deployer ${deployer.address} | balance ${ethers.formatEther(bal)} ${chain.symbol}`);

  const pad = await (await ethers.getContractFactory("NullLaunchpad")).deploy(
    uni.factory, uni.weth, p.virtualNative, p.openingTaxBps, p.openingTaxSeconds, p.launchFee, p.migrationFee, p.feeRecipient
  );
  await pad.waitForDeployment();
  const launchpad = await pad.getAddress();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    await (await pad.transferOwnership(owner)).wait();
    console.log(`Ownership transferred to ${owner}`);
  }
  const { chainId } = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlockNumber();

  const out = {
    network: network.name, chainId: Number(chainId), launchpad, uniswap: uni, deployBlock: block, owner: await pad.owner(),
    params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.toString()])),
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, `../deployments/${network.name}.json`), JSON.stringify(out, null, 2));

  const cfg = {
    chainId: Number(chainId), chainName: chain.name, rpcUrl: network.config.url || "http://127.0.0.1:8545",
    nativeSymbol: chain.symbol, explorer: chain.explorer, quickBuys: chain.quickBuys || ["0.1", "0.5", "1", "2"],
    logRpcUrls: chain.logRpcUrls || [], links: chain.links || {},
    launchpad, uniswapRouter: uni.router, weth: uni.weth, deployBlock: block,
  };
  fs.writeFileSync(path.join(__dirname, "../frontend/config.js"), `window.NULL_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
  console.log(out);
  console.log("frontend/config.js updated.");
}

main().catch((e) => { console.error(e); process.exit(1); });
