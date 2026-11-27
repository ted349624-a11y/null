// Deploys the NFT <-> coin launchpad (collection + coin implementations and the factory) and writes the page config.
//
//   PRIVATE_KEY=... npx hardhat run scripts/deploy-nft.js --network baseSepolia
//
// env (optional):
//   NFT_OWNER          owner of the factory (settings)          default: the deployer
//   NFT_FEE_RECIPIENT  receives launch, mint and trading fees    default: NFT_OWNER
//   NFT_LAUNCH_FEE     launch fee in ETH                         default: 0.0015 (about $3)
//   NFT_CONFIG_OUT     where to write the page config            default: frontend/nft-config.js
//   NFT_COLLECTION_IMPL, NFT_COIN_IMPL  reuse implementations that are already deployed (only a new factory is deployed)
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Uniswap v4, per chain (https://developers.uniswap.org/docs/protocols/v4/deployments).
const V4 = {
  4663: {
    chainName: "Robinhood Chain",
    testnet: false,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
  84532: {
    chainName: "Base Sepolia",
    testnet: true,
    rpcUrl: "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
    poolManager: "0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408",
    universalRouter: "0x492E6456D9528771018DeB9E87ef7750EF184104",
    stateView: "0x571291b572ed32ce6751a2Cb2486EbEe8DEfB9B4",
    quoter: "0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  },
};

async function main() {
  const { ethers, network } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const v4 = V4[chainId];
  if (!v4) throw new Error(`No Uniswap v4 addresses for chain ${chainId}`);
  // real money: refuse unless asked explicitly (local copies of the chain are fine)
  if (v4.testnet === false && !["hardhat", "localhost"].includes(network.name) && process.env.CONFIRM_MAINNET !== "1") throw new Error(`${v4.chainName} is mainnet: set CONFIRM_MAINNET=1`);
  const [deployer] = await ethers.getSigners();
  const signer = new ethers.NonceManager(deployer);
  const owner = process.env.NFT_OWNER || deployer.address;
  const feeRecipient = process.env.NFT_FEE_RECIPIENT || owner;
  const launchFee = ethers.parseEther(process.env.NFT_LAUNCH_FEE || "0.0015");
  if (!ethers.isAddress(owner) || !ethers.isAddress(feeRecipient)) throw new Error("NFT_OWNER / NFT_FEE_RECIPIENT must be addresses");
  for (const [k, a] of Object.entries(v4)) {
    if (k.match(/^(poolManager|universalRouter|stateView|quoter|permit2)$/) && (await ethers.provider.getCode(a)) === "0x") throw new Error(`${k} has no code at ${a}`);
  }
  console.log(`network ${network.name} (${chainId}), deployer ${deployer.address}, balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  const deploy = async (name, args = []) => {
    const c = await (await ethers.getContractFactory(name, signer)).deploy(...args);
    await c.waitForDeployment();
    console.log(`${name.padEnd(18)} ${await c.getAddress()}`);
    return c;
  };
  const startBlock = await ethers.provider.getBlockNumber();
  const reuse = async (name, addr) => {
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`${name} has no code at ${addr}`);
    console.log(`${name.padEnd(18)} ${addr} (reused)`);
    return ethers.getContractAt(name, addr);
  };
  const collectionImpl = process.env.NFT_COLLECTION_IMPL ? await reuse("NullNFTCollection", process.env.NFT_COLLECTION_IMPL) : await deploy("NullNFTCollection");
  const coinImpl = process.env.NFT_COIN_IMPL ? await reuse("NullNFTCoin", process.env.NFT_COIN_IMPL) : await deploy("NullNFTCoin");
  const factory = await deploy("NullNFTFactory", [v4.poolManager, await collectionImpl.getAddress(), await coinImpl.getAddress(), owner, feeRecipient, launchFee]);

  const out = {
    network: network.name,
    chainId,
    deployBlock: startBlock,
    factory: await factory.getAddress(),
    collectionImpl: await collectionImpl.getAddress(),
    coinImpl: await coinImpl.getAddress(),
    owner,
    feeRecipient,
    launchFee: launchFee.toString(),
    settings: { mintFeeBps: Number(await factory.mintFeeBps()), lpBps: Number(await factory.lpBps()), creatorFeeBps: Number(await factory.creatorFeeBps()), poolFee: Number(await factory.poolFee()), tickSpacing: 200 },
    v4,
    deployedAt: new Date().toISOString(),
  };
  if (!["hardhat", "localhost"].includes(network.name)) {
    fs.mkdirSync(path.join(__dirname, "../deployments"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, `../deployments/${network.name}-nft.json`), JSON.stringify(out, null, 2) + "\n");
  }
  const cfg = {
    chainId,
    chainName: v4.chainName,
    testnet: Boolean(v4.testnet),
    rpcUrl: process.env.NFT_PAGE_RPC || v4.rpcUrl,
    explorer: v4.explorer,
    factory: out.factory,
    deployBlock: startBlock,
    v4: { poolManager: v4.poolManager, universalRouter: v4.universalRouter, stateView: v4.stateView, quoter: v4.quoter, permit2: v4.permit2 },
  };
  const cfgPath = process.env.NFT_CONFIG_OUT || path.join(__dirname, "../frontend/nft-config.js");
  fs.writeFileSync(cfgPath, `// Written by scripts/deploy-nft.js\nwindow.NULL_NFT = ${JSON.stringify(cfg, null, 2)};\n`);
  console.log(`page config -> ${cfgPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
