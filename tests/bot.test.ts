import { test } from "node:test";
import assert from "node:assert/strict";
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { formatDisplayAmount, parseRawAmount, toExactDecimal } from "../src/amount";
import { buildConfig } from "../src/config";
import { DedupeCache, ethDedupeKey, zigDedupeKey } from "../src/dedupe";
import { EthereumMonitor, VAULT_ABI, makePreviewRedeem, parsePendingTx } from "../src/ethereum";
import { redact, registerSecret, setLogLevel } from "../src/logger";
import { TelegramNotifier, formatAlert } from "../src/telegram";
import { ZigChainMonitor, cometTxHash, decodeMempoolTx, makeRedemptionQuote, makeSmartQuery } from "../src/zigchain";
import type { AlertSink, EthereumVaultConfig, RedeemAlert, ZigChainConfig, ZigVaultConfig } from "../src/types";

setLogLevel("error");

const ETH_VAULT = "0x6FE78B942C566fE2b8D0881cf3577C1B1511F204";
const ZIG_VAULT = "zig1fn4rrr5knlg93nf3wyme9fzmgve3fftxu5l7wv90llp77mwg7ctq2lfwtd";
const OTHER_ZIG = "zig14j9j36ka6xnh80ya87hwccg3ya2020pcl2f94ykl9ku0w3w2hucqe7sy6d";
const USER_ZIG = "zig1wuv9zqdx3qyuqv0lwmn89aaaycur0snmgck4mx";

const baseEnv: Record<string, string> = {
  DRY_RUN: "true",
  ETHEREUM_WS_URL: "wss://eth.example/ws",
  ETHEREUM_HTTP_URL: "https://eth.example",
  ETH_VAULT_01_NAME: "NAWA USDT Vault",
  ETH_VAULT_01_ADDRESS: ETH_VAULT,
  ETH_VAULT_01_SYMBOL: "USDT",
  ETH_VAULT_01_DECIMALS: "6",
  ZIGCHAIN_RPC_URL: "https://zig.example",
  ZIGCHAIN_WS_URL: "wss://zig.example/websocket",
  ZIG_VAULT_01_NAME: "NAWA USDC Vault",
  ZIG_VAULT_01_ADDRESS: ZIG_VAULT,
  ZIG_VAULT_01_SYMBOL: "USDC",
  ZIG_VAULT_01_DECIMALS: "6",
};

class CaptureSink implements AlertSink {
  alerts: RedeemAlert[] = [];
  async send(a: RedeemAlert) {
    this.alerts.push(a);
  }
}

// ---------------- amount ----------------

test("amount: exact bigint conversion and 2-decimal display", () => {
  assert.equal(toExactDecimal(304381133898n, 6), "304381.133898");
  assert.equal(formatDisplayAmount(304381133898n, 6), "304,381.13");
  assert.equal(formatDisplayAmount(20659286n, 6), "20.66");
  assert.equal(formatDisplayAmount(0n, 6), "0.00");
  assert.equal(formatDisplayAmount(5000n, 6), "0.01"); // half-up
  assert.equal(formatDisplayAmount(4999n, 6), "0.00");
  assert.equal(formatDisplayAmount(999995000n, 6), "1,000.00");
  assert.equal(formatDisplayAmount(1234n, 0), "1,234.00");
  assert.equal(formatDisplayAmount(12n, 1), "1.20");
  assert.equal(formatDisplayAmount(10n ** 30n, 18), "1,000,000,000,000.00");
  assert.equal(parseRawAmount("19840636"), 19840636n);
  for (const bad of ["", "-1", "1.5", "1e6", " 1", "abc"]) assert.throws(() => parseRawAmount(bad));
  assert.throws(() => formatDisplayAmount(-1n, 6));
});

// ---------------- dedupe ----------------

test("dedupe: suppress repeats, separate message indexes, TTL and cap", () => {
  let now = 0;
  const d = new DedupeCache(1000, 3, () => now);
  const k0 = zigDedupeKey("ABC", 0, ZIG_VAULT);
  const k1 = zigDedupeKey("ABC", 1, ZIG_VAULT);
  assert.equal(d.checkAndMark(k0), true);
  assert.equal(d.checkAndMark(k0), false);
  assert.equal(d.checkAndMark(k1), true);
  now = 1500;
  assert.equal(d.sweep(), 2);
  assert.equal(d.checkAndMark(k0), true);
  for (const k of ["a", "b", "c", "d"]) d.checkAndMark(k);
  assert.equal(d.size, 3);
  assert.equal(ethDedupeKey("0xAB", ETH_VAULT), ethDedupeKey("0xab", ETH_VAULT.toLowerCase()));
});

// ---------------- config ----------------

test("config: loads numbered vaults dynamically", () => {
  const cfg = buildConfig({
    ...baseEnv,
    ETH_VAULT_02_NAME: "Another",
    ETH_VAULT_02_ADDRESS: "0x000000000000000000000000000000000000dEaD",
    ETH_VAULT_02_SYMBOL: "USDC",
    ETH_VAULT_02_DECIMALS: "6",
    TELEGRAM_CHAT_IDS: "123, -1001, 123",
  });
  assert.equal(cfg.ethereum.vaults.length, 2);
  assert.equal(cfg.ethereum.vaults[0]!.addressLower, ETH_VAULT.toLowerCase());
  assert.equal(cfg.zigchain.vaults.length, 1);
  assert.deepEqual(cfg.telegram.chatIds, ["123", "-1001"]);
  assert.equal(cfg.telegram.dryRun, true);
  assert.equal(cfg.dedupeTtlMs, 1440 * 60_000);
  assert.equal(cfg.alertExistingMempoolOnStart, false);
});

test("config: rejects partial, duplicate, bad decimals, bad addresses, missing telegram when live", () => {
  assert.throws(() => buildConfig({ ...baseEnv, ETH_VAULT_02_NAME: "x" }), /partially configured/);
  assert.throws(
    () =>
      buildConfig({
        ...baseEnv,
        ZIG_VAULT_02_NAME: "dup",
        ZIG_VAULT_02_ADDRESS: ZIG_VAULT,
        ZIG_VAULT_02_SYMBOL: "USDC",
        ZIG_VAULT_02_DECIMALS: "6",
      }),
    /duplicates/,
  );
  assert.throws(
    () =>
      buildConfig({
        ...baseEnv,
        ETH_VAULT_02_NAME: "dup",
        ETH_VAULT_02_ADDRESS: ETH_VAULT.toLowerCase(),
        ETH_VAULT_02_SYMBOL: "USDT",
        ETH_VAULT_02_DECIMALS: "6",
      }),
    /duplicates/,
  );
  assert.throws(() => buildConfig({ ...baseEnv, ETH_VAULT_01_DECIMALS: "" }), /missing/);
  assert.throws(() => buildConfig({ ...baseEnv, ETH_VAULT_01_DECIMALS: "6.5" }), /DECIMALS/);
  assert.throws(() => buildConfig({ ...baseEnv, ETH_VAULT_01_ADDRESS: "0x123" }), /Ethereum address/);
  assert.throws(() => buildConfig({ ...baseEnv, ZIG_VAULT_01_ADDRESS: "cosmos1abc" }), /bech32/);
  assert.throws(() => buildConfig({ ...baseEnv, ETH_VAULT_01_ADRESS: "x" }), /unknown vault field/);
  assert.throws(() => buildConfig({ ...baseEnv, DRY_RUN: "false" }), /TELEGRAM_BOT_TOKEN.*\n.*TELEGRAM_CHAT_IDS/s);
  assert.throws(() => buildConfig({ ...baseEnv, TELEGRAM_CHAT_IDS: "abc" }), /invalid chat id/);
});

test("config: error messages never contain the bot token", () => {
  const token = "1234567890:AAH_secret_token_value_xxxxxxxxxxxxx";
  try {
    buildConfig({ ...baseEnv, TELEGRAM_BOT_TOKEN: token, ETH_VAULT_01_DECIMALS: "x" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(!(e as Error).message.includes(token));
  }
});

// ---------------- ethereum ----------------

const ethVault: EthereumVaultConfig = {
  id: "01",
  network: "Ethereum",
  name: "NAWA USDT Vault",
  address: ETH_VAULT,
  addressLower: ETH_VAULT.toLowerCase(),
  symbol: "USDT",
  decimals: 6,
};
const ethCfg = { wsUrl: "wss://x", httpUrl: "https://x", vaults: [ethVault] };
const SHARES = 298187562591n;
const redeemInput = VAULT_ABI.encodeFunctionData("requestRedeem", [SHARES]);
const pendingTx = {
  hash: "0x" + "ab".repeat(32),
  from: "0x1111111111111111111111111111111111111111",
  to: ETH_VAULT.toLowerCase(), // Alchemy returns lower-case
  input: redeemInput,
};

test("ethereum: selector and calldata decoding", () => {
  assert.equal(redeemInput.slice(0, 10), "0xaa2f892d");
  const vaults = new Map([[ethVault.addressLower, ethVault]]);
  const req = parsePendingTx(pendingTx, vaults);
  assert.ok(req);
  assert.equal(req.shares, SHARES);
  assert.equal(req.wallet, pendingTx.from);
  assert.equal(req.txHash, pendingTx.hash);
  assert.equal(parsePendingTx({ ...pendingTx, to: ETH_VAULT }, vaults)?.shares, SHARES); // checksummed also matches
  assert.equal(parsePendingTx({ ...pendingTx, to: null }, vaults), null);
  assert.equal(parsePendingTx({ ...pendingTx, to: "0x000000000000000000000000000000000000dead" }, vaults), null);
  assert.equal(parsePendingTx({ ...pendingTx, input: "0xa9059cbb" + redeemInput.slice(10) }, vaults), null);
  assert.equal(parsePendingTx({ ...pendingTx, input: redeemInput.slice(0, 40) }, vaults), null);
  assert.equal(parsePendingTx({ ...pendingTx, input: "0xaa2f892d" }, vaults), null);
});

test("ethereum: positive flow -> previewRedeem -> one pending alert", async () => {
  const sink = new CaptureSink();
  const quoted: bigint[] = [];
  const mon = new EthereumMonitor(ethCfg, new DedupeCache(60_000), sink, async (_v, s) => {
    quoted.push(s);
    return 304381133898n;
  });
  const before = Date.now();
  await mon.handlePendingTx(pendingTx);
  await mon.handlePendingTx(pendingTx); // repeated pending event
  await mon.handlePendingTx({ ...pendingTx });
  assert.equal(sink.alerts.length, 1);
  assert.deepEqual(quoted, [SHARES]); // previewRedeem called with SHARES, not assets
  const a = sink.alerts[0]!;
  assert.equal(a.assetAmountRaw, 304381133898n);
  assert.ok(a.detectedAt.getTime() >= before);
  const text = formatAlert(a);
  assert.match(text, /Amount: 304,381\.13 USDT/);
  assert.match(text, /Network: Ethereum/);
  assert.match(text, /Status: Pending Redeem Request/);
  assert.match(text, new RegExp(`Tx: ${pendingTx.hash}`));
  assert.match(text, new RegExp(`Wallet: ${pendingTx.from}`));
});

test("ethereum: negative cases produce no alert", async () => {
  const sink = new CaptureSink();
  const mon = new EthereumMonitor(ethCfg, new DedupeCache(60_000), sink, async () => 1n);
  await mon.handlePendingTx({ ...pendingTx, hash: "0x" + "01".repeat(32), to: "0x000000000000000000000000000000000000dead" });
  await mon.handlePendingTx({ ...pendingTx, hash: "0x" + "02".repeat(32), input: "0xdeadbeef" + redeemInput.slice(10) });
  await mon.handlePendingTx({ ...pendingTx, hash: "0x" + "03".repeat(32), to: null });
  assert.equal(sink.alerts.length, 0);
});

test("ethereum: quote failure -> Amount: unavailable (never shares)", async () => {
  const sink = new CaptureSink();
  const mon = new EthereumMonitor(ethCfg, new DedupeCache(60_000), sink, async () => {
    throw new Error("rpc down");
  });
  await mon.handlePendingTx(pendingTx);
  assert.equal(sink.alerts.length, 1);
  assert.equal(sink.alerts[0]!.assetAmountRaw, null);
  const text = formatAlert(sink.alerts[0]!);
  assert.match(text, /Amount: unavailable\n/);
  assert.ok(!text.includes("298,187"));
});

test("ethereum: websocket subscribe, reconnect, resubscribe, no duplicate alert", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  const port = (wss.address() as { port: number }).port;
  const subscribes: any[] = [];
  wss.on("connection", (sock) => {
    sock.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      subscribes.push(req);
      sock.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: "0xsub" }));
      const push = () =>
        sock.send(JSON.stringify({ jsonrpc: "2.0", method: "eth_subscription", params: { subscription: "0xsub", result: pendingTx } }));
      push();
      push();
      if (subscribes.length === 1) setTimeout(() => sock.terminate(), 50); // drop first connection
    });
  });
  const sink = new CaptureSink();
  const mon = new EthereumMonitor({ ...ethCfg, wsUrl: `ws://127.0.0.1:${port}` }, new DedupeCache(60_000), sink, async () => 1n);
  const run = mon.start();
  for (let i = 0; i < 100 && subscribes.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  await mon.stop();
  await run;
  wss.close();
  assert.equal(subscribes.length, 2); // resubscribed after reconnect
  assert.equal(subscribes[0].method, "eth_subscribe");
  assert.deepEqual(subscribes[0].params, ["alchemy_pendingTransactions", { toAddress: [ETH_VAULT], hashesOnly: false }]);
  assert.equal(sink.alerts.length, 1);
});

test("ethereum: previewRedeem eth_call encoding/decoding", async () => {
  let sent: any;
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (304381133898n).toString(16).padStart(64, "0") }));
  }) as unknown as typeof fetch;
  const q = makePreviewRedeem("https://x", fakeFetch);
  assert.equal(await q(ethVault, SHARES), 304381133898n);
  assert.equal(sent.method, "eth_call");
  assert.equal(sent.params[0].to, ETH_VAULT);
  assert.equal(sent.params[0].data, VAULT_ABI.encodeFunctionData("previewRedeem", [SHARES]));
  assert.equal(sent.params[0].data.slice(0, 10), "0x4cdad506");
  assert.equal(sent.params[1], "latest");
});

// ---------------- zigchain ----------------

const zigVault: ZigVaultConfig = { id: "01", network: "ZigChain", name: "NAWA USDC Vault", address: ZIG_VAULT, symbol: "USDC", decimals: 6 };
const zigCfg: ZigChainConfig = { rpcUrl: "https://x", wsUrl: "", lcdUrl: "", pollMs: 500, vaults: [zigVault] };
const SHARE_DENOM = `coin.${ZIG_VAULT}.n1usdc`;

function execMsg(contract: string, msg: unknown, funds = [{ denom: SHARE_DENOM, amount: "19840636" }]) {
  return {
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    value: MsgExecuteContract.encode({
      sender: USER_ZIG,
      contract,
      msg: new TextEncoder().encode(JSON.stringify(msg)),
      funds,
    }).finish(),
  };
}

function buildTx(messages: { typeUrl: string; value: Uint8Array }[], memo = ""): string {
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages, memo })).finish();
  const raw = TxRaw.encode({ bodyBytes, authInfoBytes: new Uint8Array([1, 2, 3]), signatures: [new Uint8Array(64)] }).finish();
  return Buffer.from(raw).toString("base64");
}

const redeemTx = buildTx([execMsg(ZIG_VAULT, { request_redeem: {} })]);
const vaultMap = new Map([[ZIG_VAULT, zigVault]]);

test("zigchain: protobuf decode, sender, shares, tx hash", () => {
  const d = decodeMempoolTx(redeemTx, vaultMap);
  assert.equal(d.requests.length, 1);
  const r = d.requests[0]!;
  assert.equal(r.wallet, USER_ZIG);
  assert.equal(r.shares, 19840636n);
  assert.equal(r.messageIndex, 0);
  assert.equal(d.txHash, cometTxHash(Buffer.from(redeemTx, "base64")));
  assert.match(d.txHash, /^[0-9A-F]{64}$/);
});

test("zigchain: tx hash matches CometBFT convention (sha256 of raw bytes)", () => {
  // sha256("abc") known vector
  assert.equal(cometTxHash(new TextEncoder().encode("abc")), "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD");
});

test("zigchain: negative messages produce no requests", () => {
  const cases = [
    buildTx([execMsg(ZIG_VAULT, { approve_request: { id: 1 } })]),
    buildTx([execMsg(ZIG_VAULT, { update_aum: { aum: "1" } })]),
    buildTx([execMsg(OTHER_ZIG, { swap: { offer_asset: {} } })]),
    buildTx([execMsg(OTHER_ZIG, { request_redeem: {} })]), // unrelated vault
    buildTx([execMsg(ZIG_VAULT, { request_redeem: {}, extra: {} })]),
    buildTx([execMsg(ZIG_VAULT, { request_redeem_x: {} })]),
    buildTx([execMsg(ZIG_VAULT, "request_redeem")]),
    buildTx([
      {
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: MsgSend.encode({ fromAddress: USER_ZIG, toAddress: ZIG_VAULT, amount: [{ denom: "uzig", amount: "1" }] }).finish(),
      },
    ]),
  ];
  for (const tx of cases) assert.equal(decodeMempoolTx(tx, vaultMap).requests.length, 0);
  assert.throws(() => decodeMempoolTx("!!!not base64", vaultMap));
});

test("zigchain: multi-message tx keeps separate message indexes", () => {
  const tx = buildTx([
    execMsg(OTHER_ZIG, { swap: {} }),
    execMsg(ZIG_VAULT, { request_redeem: {} }),
    execMsg(ZIG_VAULT, { request_redeem: {} }, [{ denom: SHARE_DENOM, amount: "5" }]),
  ]);
  const d = decodeMempoolTx(tx, vaultMap);
  assert.deepEqual(d.requests.map((r) => [r.messageIndex, r.shares]), [[1, 19840636n], [2, 5n]]);
});

test("zigchain: positive flow, baseline, same tx 20 polls -> one alert", async () => {
  const sink = new CaptureSink();
  const quoted: bigint[] = [];
  const mon = new ZigChainMonitor(zigCfg, new DedupeCache(60_000), sink, { alertExistingOnStart: false, dedupeTtlMs: 60_000 }, async (_v, s) => {
    quoted.push(s);
    return 20659286n;
  });
  const oldTx = buildTx([execMsg(ZIG_VAULT, { request_redeem: {} })], "old");
  mon.processMempool([oldTx]); // startup baseline: must NOT alert
  for (let i = 0; i < 20; i++) mon.processMempool([oldTx, redeemTx]);
  await mon.drain();
  assert.equal(sink.alerts.length, 1);
  assert.deepEqual(quoted, [19840636n]); // quote uses SHARES
  const text = formatAlert(sink.alerts[0]!);
  assert.match(text, /Amount: 20\.66 USDC/);
  assert.match(text, /Network: ZigChain/);
  assert.match(text, new RegExp(`Wallet: ${USER_ZIG}`));
  assert.match(text, /Status: Pending Redeem Request/);
  assert.ok(!/confirmed|successful|completed/i.test(text));
});

test("zigchain: ALERT_EXISTING_MEMPOOL_ON_START=true alerts on snapshot", async () => {
  const sink = new CaptureSink();
  const mon = new ZigChainMonitor(zigCfg, new DedupeCache(60_000), sink, { alertExistingOnStart: true, dedupeTtlMs: 60_000 }, async () => 1n);
  mon.processMempool([redeemTx]);
  await mon.drain();
  assert.equal(sink.alerts.length, 1);
});

test("zigchain: redemption_quote via abci_query smart query", async () => {
  const { QuerySmartContractStateResponse, QuerySmartContractStateRequest } = await import("cosmjs-types/cosmwasm/wasm/v1/query");
  let url = "";
  const fakeFetch = (async (u: string) => {
    url = u;
    const value = QuerySmartContractStateResponse.encode({
      data: new TextEncoder().encode(JSON.stringify({ shares: "19840636", asset_value: "20659286" })),
    }).finish();
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: -1, result: { response: { code: 0, value: Buffer.from(value).toString("base64") } } }));
  }) as unknown as typeof fetch;
  const q = makeRedemptionQuote(makeSmartQuery({ rpcUrl: "https://rpc", lcdUrl: "" }, fakeFetch));
  assert.equal(await q(zigVault, 19840636n), 20659286n);
  assert.ok(url.startsWith("https://rpc/abci_query?path="));
  const data = new URL(url).searchParams.get("data")!.slice(2);
  const req = QuerySmartContractStateRequest.decode(Buffer.from(data, "hex"));
  assert.equal(req.address, ZIG_VAULT);
  assert.deepEqual(JSON.parse(Buffer.from(req.queryData).toString()), { redemption_quote: { shares: "19840636" } });
});

test("zigchain: quote failure -> Amount: unavailable", async () => {
  const sink = new CaptureSink();
  const mon = new ZigChainMonitor(zigCfg, new DedupeCache(60_000), sink, { alertExistingOnStart: true, dedupeTtlMs: 60_000 }, async () => {
    throw new Error("down");
  });
  mon.processMempool([redeemTx]);
  await mon.drain();
  assert.equal(sink.alerts.length, 1);
  assert.match(formatAlert(sink.alerts[0]!), /Amount: unavailable/);
});

// ---------------- telegram ----------------

const sampleAlert: RedeemAlert = {
  network: "ZigChain",
  vaultName: "NAWA USDC Vault",
  vaultAddress: ZIG_VAULT,
  symbol: "USDC",
  decimals: 6,
  wallet: USER_ZIG,
  txHash: "ABC",
  shares: 19840636n,
  assetAmountRaw: 20659286n,
  detectedAt: new Date("2026-10-17T12:45:57.123Z"),
};

test("telegram: exact alert format", () => {
  assert.equal(
    formatAlert(sampleAlert),
    [
      "🚨 Withdrawal Request Detected",
      "",
      "Vault: NAWA USDC Vault",
      "Network: ZigChain",
      "",
      `Wallet: ${USER_ZIG}`,
      "Amount: 20.66 USDC",
      "Timestamp: 2026-10-17 12:45:57 UTC",
      "",
      "Status: Pending Redeem Request",
      "Tx: ABC",
    ].join("\n"),
  );
});

test("telegram: DRY_RUN never calls the network", async () => {
  let calls = 0;
  const n = new TelegramNotifier({ botToken: "t", chatIds: ["1"], dryRun: true }, (async () => {
    calls++;
    return new Response("{}");
  }) as unknown as typeof fetch);
  await n.send(sampleAlert);
  assert.equal(calls, 0);
});

test("telegram: multi-chat fanout with per-chat isolation and bounded retry", async () => {
  const calls: Record<string, number> = {};
  const fakeFetch = (async (_u: string, init: RequestInit) => {
    const { chat_id } = JSON.parse(init.body as string);
    calls[chat_id] = (calls[chat_id] ?? 0) + 1;
    if (chat_id === "bad") return new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
    if (chat_id === "flaky" && calls[chat_id] === 1) return new Response("{}", { status: 502 });
    if (chat_id === "down") return new Response("{}", { status: 503 });
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  const n = new TelegramNotifier({ botToken: "t", chatIds: ["good", "bad", "flaky", "down"], dryRun: false }, fakeFetch);
  await n.send(sampleAlert);
  assert.equal(calls.good, 1);
  assert.equal(calls.bad, 1); // permanent error: no retry
  assert.equal(calls.flaky, 2); // retried once then succeeded
  assert.equal(calls.down, 4); // bounded
});

test("logger: redacts registered secrets and token-shaped strings", () => {
  registerSecret("supersecretvalue");
  assert.equal(redact("x supersecretvalue y"), "x *** y");
  assert.equal(redact("https://api.telegram.org/bot1234567890:AAHabcdefghijklmnopqrstuvwxyz012345/send"), "https://api.telegram.org/bot***/send");
  assert.equal(redact("wss://eth-mainnet.g.alchemy.com/v2/abc123"), "wss://eth-mainnet.g.alchemy.com/v2/***");
});
