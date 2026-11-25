window.NULL_CONFIGS = window.NULL_CONFIGS || {};
window.NULL_CONFIGS["testnet"] = {
  "version": "v2",
  "chainId": 84532,
  "chainName": "Base Sepolia",
  "rpcUrl": "https://sepolia.base.org",
  "nativeSymbol": "ETH",
  "explorer": "https://sepolia.basescan.org",
  "quickBuys": [
    "0.001",
    "0.005",
    "0.01",
    "0.02"
  ],
  "logRpcUrls": [],
  "links": {},
  "faucets": [
    {
      "name": "Coinbase Developer Platform",
      "url": "https://portal.cdp.coinbase.com/products/faucet",
      "desc": "Base's own faucet. Sign in with a free Coinbase developer account and claim small amounts, up to 0.1 ETH a day.",
      "tags": [
        "Free account",
        "Up to 0.1 ETH a day"
      ]
    },
    {
      "name": "thirdweb",
      "url": "https://thirdweb.com/base-sepolia-testnet",
      "desc": "Connect your wallet, or sign in with email or a social account, then claim once a day.",
      "tags": [
        "Wallet or social login",
        "Once a day"
      ]
    },
    {
      "name": "Chainlink",
      "url": "https://faucets.chain.link/base-sepolia",
      "desc": "Connect your wallet and claim ETH on Base Sepolia.",
      "tags": [
        "Connect wallet"
      ]
    },
    {
      "name": "Bitbond Token Tool",
      "url": "https://tokentool.bitbond.com/faucet/base-sepolia",
      "desc": "No sign-up. Connect your wallet and claim every 24 hours.",
      "tags": [
        "No sign-up",
        "Every 24h"
      ]
    },
    {
      "name": "Alchemy",
      "url": "https://www.alchemy.com/faucets/base-sepolia",
      "desc": "Paste your address, no account needed. 0.1 ETH a day, but the wallet must hold at least 0.001 ETH on Ethereum mainnet.",
      "tags": [
        "No account",
        "Needs 0.001 mainnet ETH"
      ]
    },
    {
      "name": "QuickNode",
      "url": "https://faucet.quicknode.com/base/sepolia",
      "desc": "Paste or connect your wallet, no account needed. One claim every 12 hours; the wallet needs a small mainnet balance.",
      "tags": [
        "No account",
        "Needs some mainnet ETH",
        "Every 12h"
      ]
    },
    {
      "name": "LearnWeb3",
      "url": "https://learnweb3.io/faucets/base_sepolia",
      "desc": "Multi-chain faucet. One claim a day.",
      "tags": [
        "Once a day"
      ]
    }
  ],
  "logApi": "https://base-sepolia.blockscout.com/api",
  "testnet": true,
  "launchpad": "0x5e5cF3b8a1d0B99fEaf33B985552270B28674393",
  "swapRouter": "0xf5551CD1bc1c69C8fC43D11f602032A8F5972A68",
  "swapFactory": "0x96D15c886ecD1CD2e362D6F4169928dd63af9DE2",
  "weth": "0x4200000000000000000000000000000000000006",
  "deployBlock": 63429131,
  "bridges": [
    {
      "name": "Superbridge",
      "url": "https://superbridge.app/base-sepolia",
      "desc": "Already have Sepolia ETH on Ethereum? Move it to Base Sepolia here. Deposits arrive in a few minutes.",
      "tags": [
        "Bridge",
        "A few minutes"
      ]
    }
  ]
};
