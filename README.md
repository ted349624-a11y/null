# null

**Permissionless token launchpad, live on Base at [nullfamily.fun](https://nullfamily.fun).** Fair launch on a bonding curve, automatic graduation into Uniswap V2 with liquidity locked forever. Built to move to LayerZero Zero.

## How it works

1. **Launch:** One transaction deploys a fixed-supply ERC20 (1,000,000,000) and its bonding curve. No tokens are reserved for the creator. The creator can make an optional opening buy in the same transaction, and that buy is exempt from the opening tax.
2. **Trade the curve:** Pricing is constant product over virtual reserves (1.68 native and 1B tokens), so the opening price is 0.00000000168 per token. Buying pushes the price up and selling pushes it down.
3. **Graduate:** The curve graduates when its 714M tokens (71.4%) sell out, at roughly 4.19 native raised. The final buy fills only what is left and refunds the rest in the same transaction.
4. **Trade on Uniswap:** All the native raised (minus the migration fee, capped at 10%), plus about 20.4% of supply, seeds the token/WETH Uniswap V2 pair at the curve's final price. The LP tokens are sent to `0x…dEaD`, so nobody, including the creator and the platform, can ever remove the liquidity. The remaining ~8.2% of supply is locked forever.

   Until graduation, the token refuses transfers into its Uniswap pair, so nobody can pre-seed the pool at a manipulated price. WETH donated to the pair before graduation just becomes part of the locked liquidity.

### Fees

| Fee | Rate | Recipient |
|---|---|---|
| Trade fee (every buy and sell on the curve) | 1% | 30% platform / 70% creator |
| Creator tax (optional, fixed at launch) | 0–9% (trade fee + tax ≤ 10%) | 100% creator |
| Opening tax (buys only, anti-snipe) | 80% at launch, decays linearly to 0 over 15 s | joins the trade fee (30/70) |
| After graduation | Uniswap V2 0.3% LP fee | stays in the locked pool |
| Launch fee | owner-set (0 on testnet) | platform |
| Migration fee | 0.01 native at graduation | platform |

Creator earnings accrue per token. Anyone can trigger the payout, and the money always goes to the token's **fee wallet**. The creator can change that wallet later, but nothing else about the token can be changed after launch.

## nullswap generation (testnet → Zero)

The next generation graduates into **nullswap**, null's own AMM, instead of Uniswap. It is built for chains without Uniswap (like Zero) and keeps earning after graduation.

| Contract | Role |
|---|---|
| `NullLaunchpad2.sol` | Same curve, fees, opening tax and admin as v1, plus creator records (launches / graduations). Graduates into nullswap. |
| `NullToken2.sol` | Plain fixed-supply ERC20, no restrictions |
| `swap/NullSwapFactory.sol` | Deployed by the launchpad. Only the launchpad can create pairs (always token/WETH, CREATE2). |
| `swap/NullSwapPair.sol` | Uniswap V2 pair port. Charges `1% + creator tax` on the WETH side of every swap and sends it to the launchpad (30% platform / 70% creator, creator tax 100% creator). No LP fee, no flash swaps; LP locked at `0x…dEaD`. Standard V2 events. |
| `swap/NullSwapRouter.sol` | ETH ↔ token swaps with exact quotes (quote == execution). |

Compiled with Solidity **0.8.39** (no known compiler bugs). Anything sent to a pair's predictable address before graduation is skimmed to `0x…dEaD`.

```bash
npm run deploy:testnet                 # Base Sepolia, writes frontend/config.testnet.js
GRADUATE=1 npm run smoke:testnet       # live check incl. graduation and nullswap trading
```
The site serves the testnet deployment on `testnet.<domain>` (or `?net=testnet`) and mainnet everywhere else.

## Contracts

| Contract | Role |
|---|---|
| `NullLaunchpad.sol` | Factory, bonding curves, fees, opening tax, graduation, and frontend views (`getLaunches`, `getLaunch`) |
| `NullToken.sol` | Plain fixed-supply ERC20: no owner, no mint, no transfer tax. Blocks transfers into its Uniswap pair until graduation. |

## Deployments

| Network | NullLaunchpad | Owner |
|---|---|---|
| Base (8453) | [`0x4dE50B493d3CE956222D4c09AFF6bd3b16c3E77a`](https://basescan.org/address/0x4dE50B493d3CE956222D4c09AFF6bd3b16c3E77a#code) ✓ verified | `0xf20949dE03Fbd6EeC56eE4d674759D2e5DA02f55` |

Base parameters for new launches: virtual reserve 1.68 ETH (graduates at ~4.19 ETH), opening tax 80% → 0 over 15 s, launch fee 0, migration fee 0.01 ETH. The owner can change the virtual reserve, launch fee and migration fee from the site's **Admin** panel; changes apply to new launches only.

Graduates into Uniswap V2 on Base (factory `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`, router `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24`). Live-tested on 2026-11-25: a test token launched at a ~$3 threshold graduated into pair [`0xB0D0f1EdCfff1Ce173467A960547110EFe82F533`](https://basescan.org/address/0xB0D0f1EdCfff1Ce173467A960547110EFe82F533) with its LP burned, then traded on Uniswap.

**Testnet (nullswap generation) on Base Sepolia** — live at [testnet.nullfamily.fun](https://testnet.nullfamily.fun), all source-verified:

| Contract | Address |
|---|---|
| NullLaunchpad2 | [`0x5e5cF3b8a1d0B99fEaf33B985552270B28674393`](https://sepolia.basescan.org/address/0x5e5cF3b8a1d0B99fEaf33B985552270B28674393#code) |
| NullSwapFactory | [`0x96D15c886ecD1CD2e362D6F4169928dd63af9DE2`](https://sepolia.basescan.org/address/0x96D15c886ecD1CD2e362D6F4169928dd63af9DE2#code) |
| NullSwapRouter | [`0xf5551CD1bc1c69C8fC43D11f602032A8F5972A68`](https://sepolia.basescan.org/address/0xf5551CD1bc1c69C8fC43D11f602032A8F5972A68#code) |

Testnet parameters: virtual reserve 0.0168 ETH (graduates at ~0.042 ETH), migration fee 0.0001 ETH. Live-tested end to end, including graduation into nullswap and pool-fee payouts.

An earlier Base deployment (`0x625Cd5Bb…4859`, own AMM instead of Uniswap) is retired.

### Verifying contracts

Source is verified on Basescan. To verify a new deployment or a launched token (`ETHERSCAN_API_KEY` in `.env`; one Etherscan V2 key covers Base):
```bash
npx hardhat verify --network base <launchpad> <uniswapFactory> <weth> <virtualNative> <openingTaxBps> <openingTaxSeconds> <launchFee> <migrationFee> <feeRecipient>
npx hardhat verify --network base --contract contracts/NullToken.sol:NullToken <token> "<name>" "<SYMBOL>" <creator> 1000000000000000000000000000 <uniswapFactory> <weth>
```

## Zero network

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 43002 | 33002 |
| RPC | `https://testnet.zero.layerzero.network` | `https://rudolph.zero.layerzero.network` |
| Native | ZRO | ZRO |

## Quick start

```bash
npm install
npm test                    # 28 tests: v1 against real Uniswap V2 bytecode + the nullswap generation (offline: USE_LOCAL_SOLC=1 npm test)
```

### Deploy to Zero testnet
```bash
cp .env.example .env        # add a testnet PRIVATE_KEY funded with testnet ZRO
npm run deploy:testnet      # deploys and writes frontend/config.js
npm run serve               # http://localhost:8080
```
The frontend is static (`frontend/`), so you can host it as-is on Vercel, Netlify, Cloudflare Pages or IPFS.

**Vercel:** import the repo and deploy. `vercel.json` serves `frontend/` and skips installing the Hardhat toolchain. After every `npm run deploy:testnet`, commit the updated `frontend/config.js` so the site points at the new contracts. Until then the site shows a "coming soon" screen.

**Check RPC access first.** The testnet RPC may be restricted. If this returns `403`, ask LayerZero for testnet access:
```bash
curl -s -X POST https://testnet.zero.layerzero.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# expected: {"jsonrpc":"2.0","id":1,"result":"0xa7fa"}
```

**Verify the live deployment:**
```bash
npm run smoke:testnet               # launch, opening tax decay, buy, sell, events, creator fees
GRADUATE=1 npm run smoke:testnet    # also graduates into Uniswap V2 and trades there
```
Testnet ZRO is scarce. To test graduation cheaply, deploy with a smaller curve, for example `VIRTUAL_NATIVE=0.0168`, which graduates at about 0.042 ZRO.

### Local demo
```bash
npm run node                # terminal 1
npm run deploy:local        # terminal 2
npm run serve
```

## Quests and points

`nullfamily.fun` opens on the quests page (`frontend/quests.html`); `testnet.nullfamily.fun` opens the testnet app (`frontend/app.html`, rewrites in `vercel.json`).

- **Homepage, no wallet:** players enter their X username and do the X quests (follow, turn on notifications, like, repost, reply; the reply text is their own). Progress is saved under the username, so it survives switching browsers or devices. These quests are self-reported: X's API can't confirm them without a paid plan, and notifications can't be checked at all.
- **Then the testnet:** after the last X quest a "Go to testnet" button takes players to `testnet.nullfamily.fun/?xu=<username>`. The app shows their points straight away; connecting a wallet and signing a free message saves them to that wallet. On phones without a wallet the button opens the testnet in MetaMask with the username carried over.
- **Testnet quests** (launch, buy, sell, trade a graduated token on nullswap) are checked on-chain right after each confirmed transaction (by tx hash over RPC, otherwise the wallet's history on Blockscout).
- Every quest is worth 500 points, done in order. One X username per wallet and one wallet per X username; X quests finished after linking go straight to the linked wallet.

Backend: Vercel functions in `api/` (`config`, `xprogress`, `login`, `me`, `x`, `task`, `points`, `leaderboard`), shared code in `lib/points.js`, storage in Upstash Redis (connected under Vercel → Storage; the `KV_REST_API_*` variables are picked up automatically).

Settings: the X account and post go in `lib/quest-config.js`, or in the `X_HANDLE` / `X_POST_ID` environment variables. Without an X account the quests page shows "opening soon" and the testnet app hides its points UI; without a post the like / repost / reply quests point at the X profile until one is added.

Local run (points in memory): `node scripts/dev-server.js 8095`, then open `http://localhost:8095` (quests) and `http://testnet.localhost:8095` (testnet app).

## Activity index

Charts, trade lists, the homepage tiles, ticker and rankings, and "my coins" read from our own index in Redis (`lib/chainindex.js`), not from a third-party indexer at request time:

- Backfilled once from Blockscout, then it follows the chain over the public RPC in 200-block chunks (the most the RPC allows), at most once a minute, whenever someone asks for data. If Blockscout is down it rebuilds from the chain alone.
- A user's own trade is added from its receipt right after it confirms (`POST /api/history`), so it shows at once.
- While storing it keeps running summaries (per-token numbers, hourly totals, wallets, latest trades, rankings, per-wallet token sets), so reading them costs a handful of commands; most requests are answered from memory.
- `GET /api/history?status=1` shows where it stands (last indexed block, chain head, lag, last error).
- Load-tested locally with 1,000 launches, 2,120 trades and 5 graduations: every number matched the chain, the phone homepage showed tokens in ~1s.

## Charts and trade history

Token pages show a market-cap candlestick chart (Auto / 1m / 5m / 15m / 1h) and the latest trades from both the bonding curve and the pool. Base's public RPCs refuse wide `eth_getLogs` ranges, so the site reads history from the chain's public Blockscout API (`logApi` in the config; no key, timestamps included) and falls back to the wallet's RPC. Charts use TradingView's open-source [Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0, vendored in `frontend/vendor/` with its license).

## Before mainnet
- [ ] Independent security audit (the code is tested, not audited)
- [ ] Use a multisig for the owner and `FEE_RECIPIENT`
- [ ] Tune `VIRTUAL_NATIVE` to ZRO's USD price, since it sets the starting market cap and the graduation size
- [ ] Image uploads (IPFS) and an indexer for faster lists and charts
- [ ] Terms of use and a regulatory review for your jurisdiction

## Roadmap
Price charts, comments, holder fee sharing, buyback & vest, cross-chain tokens via LayerZero OFT.

## Apply form

`/apply` is a short form (X username + EVM address), like a Google Form. Answers are stored in Redis
(`ap:a`, `ap:u`, `ap:n`); one address per X username, and resubmitting from the same address updates the
username but keeps the application number. The team sees the answers at `/apply/responses` after signing
in with a wallet (no transaction): the launchpad owners from `deployments/` by default, plus any address in
the `APPLY_ADMINS` env var (comma-separated). CSV download and copy buttons are there. The API lives in
`lib/apply.js` and is served through `api/x.js` (`/api/apply`, `/api/apply/responses`).
