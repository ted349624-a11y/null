// Deploy null to Zero testnet:
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network zeroTestnet
//
// Optional env (defaults in brackets):
//   VIRTUAL_NATIVE      [1.68]   virtual native reserve -> curve graduates at ~2.5x this (~4.2)
//   OPENING_TAX_BPS     [8000]   anti-snipe buy tax at t=0 (80%)
//   OPENING_TAX_SECONDS [15]     seconds until the opening tax reaches 0
//   LAUNCH_FEE          [0]      native fee to create a token
//   MIGRATION_FEE       [0.01]   native taken from the curve at graduation
//   FEE_RECIPIENT       [deployer]
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const CHAINS = {
  zeroTestnet: { name: "Zero Testnet", symbol: "ZRO", explorer: process.env.EXPLORER_URL || "" },
  zero: { name: "Zero", symbol: "ZRO", explorer: process.env.EXPLORER_URL || "https://explorer.zero.layerzero.network" },
  localhost: { name: "Localhost", symbol: "ETH", explorer: "" },
  hardhat: { name: "Hardhat", symbol: "ETH", explorer: "" },
};

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account. Set PRIVATE_KEY.");
  const p = {
    virtualNative: ethers.parseEther(process.env.VIRTUAL_NATIVE || "1.68"),
    openingTaxBps: BigInt(process.env.OPENING_TAX_BPS || "8000"),
    openingTaxSeconds: BigInt(process.env.OPENING_TAX_SECONDS || "15"),
    launchFee: ethers.parseEther(process.env.LAUNCH_FEE || "0"),
    migrationFee: ethers.parseEther(process.env.MIGRATION_FEE || "0.01"),
    feeRecipient: process.env.FEE_RECIPIENT || deployer.address,
  };
  const chain = CHAINS[network.name] || { name: network.name, symbol: "ETH", explorer: "" };
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Network ${network.name} | deployer ${deployer.address} | balance ${ethers.formatEther(bal)} ${chain.symbol}`);

  const pad = await (await ethers.getContractFactory("NullLaunchpad")).deploy(
    p.virtualNative, p.openingTaxBps, p.openingTaxSeconds, p.launchFee, p.migrationFee, p.feeRecipient
  );
  await pad.waitForDeployment();
  const launchpad = await pad.getAddress();
  const swap = await pad.swap();
  const { chainId } = await ethers.provider.getNetwork();
  const block = await ethers.provider.getBlockNumber();

  const out = {
    network: network.name, chainId: Number(chainId), launchpad, swap, deployBlock: block,
    params: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.toString()])),
    deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, `../deployments/${network.name}.json`), JSON.stringify(out, null, 2));

  const cfg = { chainId: Number(chainId), chainName: chain.name, rpcUrl: network.config.url || "http://127.0.0.1:8545", nativeSymbol: chain.symbol, explorer: chain.explorer, launchpad, swap };
  cfg.deployBlock = block;
  fs.writeFileSync(path.join(__dirname, "../frontend/config.js"), `window.NULL_CONFIG = ${JSON.stringify(cfg, null, 2)};\n`);
  console.log(out);
  console.log("frontend/config.js updated.");
}

main().catch((e) => { console.error(e); process.exit(1); });
