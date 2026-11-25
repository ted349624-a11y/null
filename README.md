# null

**Permissionless token launchpad on LayerZero Zero.** Fair launch on a bonding curve, automatic graduation into a pool whose liquidity is locked forever.

## How it works

1. **Launch:** One transaction deploys a fixed-supply ERC20 (1,000,000,000) and its bonding curve. No tokens are reserved for the creator. The creator can make an optional opening buy in the same transaction, and that buy is exempt from the opening tax.
2. **Trade the curve:** Pricing is constant product over virtual reserves (1.68 native and 1B tokens), so the opening price is 0.00000000168 per token. Buying pushes the price up and selling pushes it down.
3. **Graduate:** The curve graduates when its 714M tokens (71.4%) sell out, at roughly 4.19 native raised. The final buy fills only what is left and refunds the rest in the same transaction.
4. **Trade the pool:** All the native raised (minus the migration fee), plus about 20.4% of supply, seeds a NullSwap pool at the curve's final price. The remaining ~8.2% is locked forever. Pool liquidity has no withdraw function, so nobody, including the creator and the platform, can remove it.

### Fees

| Fee | Rate | Recipient |
|---|---|---|
| Trade fee (every buy and sell, curve and pool) | 1% | 30% platform / 70% creator |
| Creator tax (optional, fixed at launch) | 0–9% (trade fee + tax ≤ 10%) | 100% creator |
| Opening tax (buys only, anti-snipe) | 80% at launch, decays linearly to 0 over 15 s | joins the trade fee (30/70) |
| Pool LP fee | none | n/a |
| Launch fee | owner-set (0 on testnet) | platform |
| Migration fee | 0.01 native at graduation | platform |

Creator earnings accrue per token. Anyone can trigger the payout, and the money always goes to the token's **fee wallet**. The creator can change that wallet later, but nothing else about the token can be changed after launch.

## Contracts

| Contract | Role |
|---|---|
| `NullLaunchpad.sol` | Factory, bonding curves, fees, opening tax, graduation, and frontend views (`getLaunches`, `getLaunch`) |
| `NullToken.sol` | Plain fixed-supply ERC20: no owner, no mint, no transfer tax |
| `NullSwap.sol` | Constant-product pools for graduated tokens. Liquidity is locked and fees match the curve. |

## Zero network

| | Testnet | Mainnet |
|---|---|---|
| Chain ID | 43002 | 33002 |
| RPC | `https://testnet.zero.layerzero.network` | `https://rudolph.zero.layerzero.network` |
| Native | ZRO | ZRO |

## Quick start

```bash
npm install
npm test                    # 17 tests (offline: USE_LOCAL_SOLC=1 npm test)
```

### Deploy to Zero testnet
```bash
cp .env.example .env        # add a testnet PRIVATE_KEY funded with testnet ZRO
npm run deploy:testnet      # deploys and writes frontend/config.js
npm run serve               # http://localhost:8080
```
The frontend is static (`frontend/`), so you can host it as-is on Vercel, Netlify, Cloudflare Pages or IPFS.

**Check RPC access first.** The testnet RPC may be restricted. If this returns `403`, ask LayerZero for testnet access:
```bash
curl -s -X POST https://testnet.zero.layerzero.network -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# expected: {"jsonrpc":"2.0","id":1,"result":"0xa7fa"}
```

**Verify the live deployment:**
```bash
npm run smoke:testnet               # launch, opening tax decay, buy, sell, events, creator fees
GRADUATE=1 npm run smoke:testnet    # also sells out the curve and trades on the pool
```
Testnet ZRO is scarce. To test graduation cheaply, deploy with a smaller curve, for example `VIRTUAL_NATIVE=0.0168`, which graduates at about 0.042 ZRO.

### Local demo
```bash
npm run node                # terminal 1
npm run deploy:local        # terminal 2
npm run serve
```

## Before mainnet
- [ ] Independent security audit (the code is tested, not audited)
- [ ] Use a multisig for the owner and `FEE_RECIPIENT`
- [ ] Tune `VIRTUAL_NATIVE` to ZRO's USD price, since it sets the starting market cap and the graduation size
- [ ] Image uploads (IPFS) and an indexer for faster lists and charts
- [ ] Terms of use and a regulatory review for your jurisdiction

## Roadmap
Price charts, comments, holder fee sharing, buyback & vest, cross-chain tokens via LayerZero OFT.
