# nawa-finance-redeemer

Telegram alert bot that detects **user redeem / withdrawal requests while they are still pending** on:

- **Ethereum Mainnet**: NAWA USDT Vault, `requestRedeem(uint256 shares)` (selector `0xaa2f892d`)
- **ZigChain Mainnet**: NAWA USDC Vault (CosmWasm), `{"request_redeem":{}}`

It alerts as soon as the request is seen in the mempool. It never waits for block confirmation, `approve_request`, queue processing or payout.

> This is **not** a confirmed-withdrawal bot. Every alert is labelled `Status: Pending Redeem Request`.

---

## Detection flow

### Ethereum

```
Alchemy WSS eth_subscribe("alchemy_pendingTransactions", { toAddress: [vaults], hashesOnly: false })
 → tx.to matches a configured vault (case-insensitive)
 → tx.input starts with 0xaa2f892d and holds ≥ 1 uint256 word
 → shares = first uint256 (bigint)
 → eth_call previewRedeem(shares) on "latest" (HTTP RPC)
 → Telegram alert (wallet = tx.from, tx = tx.hash, timestamp = detection time)
```

**Why Alchemy pending WebSocket:** standard `newPendingTransactions` only gives hashes and needs one extra RPC call per tx. `alchemy_pendingTransactions` filters by `toAddress` on the server and pushes full tx objects, so only vault txs arrive and calldata can be decoded straight away.

### ZigChain

```
GET {ZIGCHAIN_RPC_URL}/unconfirmed_txs?limit=100   (sequential loop, every ZIG_MEMPOOL_POLL_MS)
 → base64 → TxRaw → TxBody → Any[]      (cosmjs-types protobuf decoding)
 → typeUrl == /cosmwasm.wasm.v1.MsgExecuteContract
 → contract == configured vault (exact)
 → msg JSON is exactly {"request_redeem":{...}}
 → shares = funds amount (vault share denom coin.<vault>.*)
 → smart query {"redemption_quote":{"shares":"<raw>"}} → asset_value
 → Telegram alert (wallet = sender, tx = SHA-256(raw tx bytes) upper-case hex)
```

**Why `/unconfirmed_txs`:** this is the CometBFT mempool, the only RPC source that shows a tx *before* it is in a block.

**Why `tm.event='Tx'` is NOT used:** that event fires only after the tx has been executed and included in a block, which is too late for this bot. The ZigChain WebSocket is used only for **liveness** (a `NewBlockHeader` subscription, with reconnect and a stall warning). It does not trigger alerts.

**Smart-query transport:** the configured RPC host does **not** serve the REST route `/cosmwasm/wasm/v1/contract/{addr}/smart/{q}` (it returns 404). Quotes therefore go through CometBFT `abci_query` with path `/cosmwasm.wasm.v1.Query/SmartContractState` (protobuf request and response). This was verified live: `19840636` shares returned `asset_value` `20659286`. If you set `ZIGCHAIN_LCD_URL`, the REST route on that LCD is used instead. Both are isolated in `makeSmartQuery()` in `src/zigchain.ts`.

---

## Shares vs underlying asset

Both vaults take **shares** as the redeem input, not USDT or USDC. The bot never shows shares as an asset amount:

| Chain    | Input (shares)   | Quote call                  | Example                           |
|----------|------------------|-----------------------------|-----------------------------------|
| Ethereum | `298187562591`   | `previewRedeem(shares)`     | `304381133898` → 304,381.13 USDT  |
| ZigChain | `19840636`       | `redemption_quote {shares}` | `20659286` → 20.66 USDC           |

## Pending alert semantics

- **Timestamp** is the detection time in UTC, because a pending tx has no block time yet.
- **Amount** is the *current* quote against the latest vault state when the request is detected. It is the best immediate estimate, **not** a guaranteed settlement value: NAV can change before the tx is included or processed.
- If the tx later fails or is dropped, the alert has already been sent. That is inherent to pending detection.
- **Quote failure strategy:** the bot tries the quote 3 times (5–8 s timeout each, short backoff). If it still fails, the alert is still sent, with `Amount: unavailable`. A pending request is never suppressed, and shares are never substituted for the asset amount.

## Alert format

```
🚨 Withdrawal Request Detected

Vault: NAWA USDC Vault
Network: ZigChain

Wallet: zig1...
Amount: 20.66 USDC
Timestamp: 2026-10-17 12:45:57 UTC

Status: Pending Redeem Request
Tx: <transaction hash>
```

Amounts use exact `bigint` maths, are rounded half-up to 2 decimals and use comma separators. Messages are sent as plain text (no Markdown or HTML parsing), so on-chain strings cannot break the formatting.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | when `DRY_RUN=false` | Bot token. Never logged. |
| `TELEGRAM_CHAT_IDS` | when `DRY_RUN=false` | Comma-separated chat IDs (`123,-100123…`, or `@channel`). |
| `DRY_RUN` | no (default `true`) | `true` prints alerts to the logs instead of sending them. |
| `ETHEREUM_WS_URL` | if ETH vaults | Alchemy WSS endpoint. |
| `ETHEREUM_HTTP_URL` | if ETH vaults | HTTP RPC for `previewRedeem`. |
| `ETH_VAULT_NN_NAME/ADDRESS/SYMBOL/DECIMALS` | ≥1 vault total | Numbered Ethereum vaults. |
| `ZIGCHAIN_RPC_URL` | if ZIG vaults | CometBFT RPC (mempool + abci_query). |
| `ZIGCHAIN_WS_URL` | no | CometBFT WebSocket, used for liveness only. |
| `ZIGCHAIN_LCD_URL` | no | Optional LCD for smart queries. Empty = RPC `abci_query`. |
| `ZIG_MEMPOOL_POLL_MS` | no (default `500`) | Mempool poll interval (100–60000). |
| `ZIG_VAULT_NN_NAME/ADDRESS/SYMBOL/DECIMALS` | ≥1 vault total | Numbered ZigChain vaults. |
| `DEDUPE_TTL_MINUTES` | no (default `1440`) | How long a seen tx is remembered. |
| `ALERT_EXISTING_MEMPOOL_ON_START` | no (default `false`) | Whether to alert on redeem txs already in the mempool at startup. |
| `LOG_LEVEL` | no (default `info`) | `debug` \| `info` \| `warn` \| `error` |

Config is validated at startup, and the bot exits with a clear list of problems if any of these occur:
- a vault record is missing a field (partial record)
- a vault field name is unknown (e.g. a typo like `_ADRESS`)
- the same vault address appears twice
- decimals are invalid
- an address is invalid (bad Ethereum checksum, or not a `zig1…` bech32 address)
- `DRY_RUN=false` but the Telegram token or chat IDs are empty

### Adding a new vault

Only edit `.env`. No code changes are needed:

```env
ETH_VAULT_02_NAME=Another Vault
ETH_VAULT_02_ADDRESS=0x...
ETH_VAULT_02_SYMBOL=USDC
ETH_VAULT_02_DECIMALS=6

ZIG_VAULT_02_NAME=Another Zig Vault
ZIG_VAULT_02_ADDRESS=zig1...
ZIG_VAULT_02_SYMBOL=USDT
ZIG_VAULT_02_DECIMALS=6
```

Restart the bot afterwards. All configured Ethereum vaults are placed in the Alchemy `toAddress` filter.

New Ethereum vaults must expose `requestRedeem(uint256)` / `previewRedeem(uint256)`. New ZigChain vaults must accept `request_redeem` and answer `redemption_quote`.

### Multiple Telegram chats

Set `TELEGRAM_CHAT_IDS=123456789,987654321`. Every alert goes to every chat in parallel:
- A failure in one chat never blocks the others.
- Network errors, 5xx responses and 429 (honouring `retry_after`, capped at 30 s) are retried up to 4 attempts.
- 4xx errors such as "chat not found" are not retried.

### DRY_RUN

`DRY_RUN=true` (the default) runs the full pipeline: detection, decoding, quote, formatting and dedupe. The final alert text is printed to the logs and nothing is sent to Telegram. Set `DRY_RUN=false` only after filling in the token and chat IDs.

---

## Local commands

```bash
npm install
npm run typecheck   # src + tests
npm run build       # → dist/
npm test            # unit/acceptance tests (node:test via tsx)
npm run dev         # run from source (tsx)
npm run start       # run compiled dist/index.js
```

Requires Node.js 20 or newer.

## Docker

```bash
docker compose up -d --build
docker compose logs -f
docker compose restart
docker compose down
```

How the image is set up:
- Multi-stage `node:20-alpine` build using `npm ci` from the lockfile.
- Runs as the non-root `node` user and exposes no ports.
- `.env` is excluded by `.dockerignore` and passed in at runtime through `env_file`, so secrets are never baked into the image.
- `init: true` forwards SIGTERM so shutdown is graceful.
- No healthcheck is defined. The bot has no HTTP surface, and a process-alive check would add nothing over `restart: unless-stopped`.

---

## Reconnect / retry behaviour

| Component | Behaviour |
|---|---|
| ETH WebSocket | Reconnects with exponential backoff (1 s → max 60 s, ±20 % jitter). The backoff resets after a connection has stayed up for 60 s. Resubscribes on every connect. A 30 s ping with a 10 s pong timeout detects dead sockets. The subscription must be confirmed within 15 s. Missed pending txs are never fabricated after a reconnect. |
| ETH previewRedeem | 3 attempts, 8 s timeout each. |
| ZIG mempool poll | One sequential `await poll → await sleep` loop, so requests never overlap. 5 s timeout per request. On errors it backs off 1 s → max 30 s, then returns to normal polling once the RPC recovers. |
| ZIG redemption_quote | 3 attempts, 5 s timeout each. |
| ZIG WebSocket (liveness) | Reconnects with backoff (max 60 s). If no new block arrives for 60 s it warns and reconnects. |
| Monitor isolation | The ETH and ZIG monitors run independently, and each catches its own errors. |
| Shutdown | SIGINT/SIGTERM stop both monitors and wait for in-flight alerts (forced exit after 15 s). |

**Dedupe:**
- Ethereum key: `network + txHash + vault`. ZigChain key: `network + txHash + messageIndex + vault`.
- Entries expire after the TTL, and the cache is capped at 100k entries.
- Each mempool tx is decoded only once.
- A tx that stays in the mempool for many polls produces exactly one alert.

**Startup:**
- Ethereum only receives txs that arrive after it subscribes.
- The first successful ZigChain mempool snapshot is treated as a baseline and is not alerted (unless `ALERT_EXISTING_MEMPOOL_ON_START=true`).
- After a temporary RPC outage, polling continues with the same dedupe state. A redeem tx that entered the mempool during the outage and is still pending is alerted once.

---

## Known limitations

- **ZigChain mempool page size:** CometBFT returns at most 100 txs from `/unconfirmed_txs` and has no pagination. If the mempool is larger, the bot warns `mempool larger than one page`, and txs beyond the first 100 are not visible until the mempool shrinks.
- **Direct calls only:** Ethereum detection needs the pending tx's `to` to be the vault. A `requestRedeem` sent *through* another contract (a Safe multisig, router or account-abstraction bundler) is not visible this way. ZigChain detection likewise covers top-level `MsgExecuteContract` messages, not messages wrapped in `authz MsgExec`.
- **Single-node view:** the bot sees only the mempool of the configured ZigChain RPC node. A tx broadcast to another node appears there once it has gossiped through the network, or shortly before inclusion.
- **Restarts:** dedupe is held in memory. After a restart, txs already in the mempool are baselined (not re-alerted) by default.

## Troubleshooting

| Symptom | Check |
|---|---|
| `invalid configuration: …` at startup | Fix the listed `.env` keys. Partial vault records and typos are rejected on purpose. |
| `pending subscription rejected` | The Alchemy key or plan does not support `alchemy_pendingTransactions`, or the WSS URL is wrong. |
| `websocket disconnected, reconnecting` repeating | Network or provider problem. Backoff caps at 60 s, so the RPC is not hammered. |
| `rpc timeout, retrying` (ZIG) | The ZigChain RPC is slow or down. Polling backs off up to 30 s and recovers automatically. |
| `Amount: unavailable` in alerts | The quote call failed 3 times. Check `ETHEREUM_HTTP_URL`, or the ZigChain RPC / `ZIGCHAIN_LCD_URL`. |
| No Telegram messages | Check `DRY_RUN=false`, that the token and chat IDs are set, that the bot has been added to the chat or channel, and look for `[TG] alert failed for chat` logs. |
| Want more detail | Set `LOG_LEVEL=debug` to see per-poll mempool counts, new blocks and suppressed duplicates. |
