// Deploys the canonical Uniswap V2 bytecode (WETH9, Factory, Router02) for local tests.
const { ethers } = require("hardhat");

const art = (p) => require(p);
const WETH9 = art("@uniswap/v2-periphery/build/WETH9.json");
const Factory = art("@uniswap/v2-core/build/UniswapV2Factory.json");
const Pair = art("@uniswap/v2-core/build/UniswapV2Pair.json");
const Router = art("@uniswap/v2-periphery/build/UniswapV2Router02.json");

async function deployUniswap(signer) {
  const weth = await new ethers.ContractFactory(WETH9.abi, WETH9.bytecode, signer).deploy();
  const factory = await new ethers.ContractFactory(Factory.abi, Factory.bytecode, signer).deploy(signer.address);
  const router = await new ethers.ContractFactory(Router.abi, Router.bytecode, signer).deploy(await factory.getAddress(), await weth.getAddress());
  await Promise.all([weth.waitForDeployment(), factory.waitForDeployment(), router.waitForDeployment()]);
  return { weth, factory, router, pairAt: (a) => new ethers.Contract(a, Pair.abi, signer) };
}

module.exports = { deployUniswap, PairAbi: Pair.abi, RouterAbi: Router.abi };
