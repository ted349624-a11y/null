require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

const PK = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true } },
  networks: {
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

// Offline fallback: set USE_LOCAL_SOLC=1 to compile with the solcjs build in node_modules.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (process.env.USE_LOCAL_SOLC !== "1") return runSuper();
  return { compilerPath: require.resolve("solc/soljson.js"), isSolcJs: true, version: args.solcVersion, longVersion: require("solc").version() };
});
