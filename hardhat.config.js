require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

// v1 (deployed on Base mainnet, verified): NullLaunchpad + NullToken, Solidity 0.8.24, graduates to Uniswap V2.
const V1 = { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } };
// v2 (nullswap generation): Solidity 0.8.39 (no known compiler bugs), Cancun target for broad chain support.
const V2 = { version: "0.8.39", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" } };

module.exports = {
  solidity: {
    compilers: [V2],
    overrides: {
      "contracts/NullLaunchpad.sol": V1,
      "contracts/NullToken.sol": V1,
    },
  },
  // Etherscan API V2: one key works for Basescan and every other Etherscan-family explorer.
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY || "" },
  sourcify: { enabled: false },
  networks: {
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: PK,
    },
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts: PK,
    },
    // LayerZero Zero — EVM (Interop) Zone. Native currency: ZRO.
    zeroTestnet: {
      url: process.env.ZERO_TESTNET_RPC_URL || "https://testnet.zero.layerzero.network",
      chainId: 43002,
      accounts: PK,
    },
    zero: {
      url: process.env.ZERO_RPC_URL || "https://rudolph.zero.layerzero.network",
      chainId: 33002,
      accounts: PK,
    },
  },
};

// Offline fallback: set USE_LOCAL_SOLC=1 to compile with the solcjs builds in node_modules.
const LOCAL_SOLC = { "0.8.24": "solc", "0.8.39": "solc0839" };
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (process.env.USE_LOCAL_SOLC !== "1") return runSuper();
  const pkg = LOCAL_SOLC[args.solcVersion];
  if (!pkg) throw new Error(`No local solcjs for ${args.solcVersion}`);
  return {
    compilerPath: require.resolve(`${pkg}/soljson.js`),
    isSolcJs: true,
    version: args.solcVersion,
    longVersion: require(pkg).version().replace(".Emscripten.clang", ""),
  };
});
