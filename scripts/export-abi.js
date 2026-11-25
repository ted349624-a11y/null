// Writes frontend/abi.js from compiled artifacts. Run after `npx hardhat compile`.
const fs = require("fs");
const path = require("path");
const read = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, `../artifacts/contracts/${n}.sol/${n}.json`))).abi;
const out = { launchpad: read("NullLaunchpad"), swap: read("NullSwap"), token: read("NullToken") };
fs.writeFileSync(path.join(__dirname, "../frontend/abi.js"), `window.NULL_ABI = ${JSON.stringify(out)};\n`);
console.log("frontend/abi.js written");
