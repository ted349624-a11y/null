// Writes frontend/abi.js from compiled artifacts. Run after `npx hardhat compile`.
const fs = require("fs");
const path = require("path");
const read = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, `../artifacts/contracts/${n}.sol/${n}.json`))).abi;
const out = {
  launchpad: read("NullLaunchpad"),
  token: read("NullToken"),
  // v2 generation (nullswap)
  launchpad2: read("NullLaunchpad2"),
  token2: read("NullToken2"),
  nullRouter: JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/contracts/swap/NullSwapRouter.sol/NullSwapRouter.json"))).abi,
  // Uniswap V2 Router02 (subset used by the frontend)
  router: [
    "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
    "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)",
    "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
  ],
};
fs.writeFileSync(path.join(__dirname, "../frontend/abi.js"), `window.NULL_ABI = ${JSON.stringify(out)};\n`);
console.log("frontend/abi.js written");
