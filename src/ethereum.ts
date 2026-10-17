import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { Interface } from "ethers";
import { ethDedupeKey, type DedupeCache } from "./dedupe";
import { createLogger, errMsg } from "./logger";
import type { AlertSink, EthereumConfig, EthereumVaultConfig, RawRedeemRequest, RedeemAlert } from "./types";

const log = createLogger("ETH");

export const REQUEST_REDEEM_SELECTOR = "0xaa2f892d";
export const VAULT_ABI = new Interface([
  "function requestRedeem(uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
]);

const SUBSCRIBE_ID = 1;
const CONNECT_TIMEOUT_MS = 15_000;
const SUBSCRIBE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const RPC_TIMEOUT_MS = 8_000;
const QUOTE_ATTEMPTS = 3;
const QUOTE_RETRY_DELAY_MS = 750;

/** Subset of the Alchemy pending transaction object we rely on. */
export interface PendingTx {
  hash?: string;
  from?: string;
  to?: string | null;
  input?: string;
}

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/**
 * Pure decode step: returns a redeem request if tx is requestRedeem(uint256) on a configured vault.
 * Never waits for receipt/confirmation.
 */
export function parsePendingTx(
  tx: PendingTx,
  vaults: ReadonlyMap<string, EthereumVaultConfig>,
  now: Date = new Date(),
): RawRedeemRequest | null {
  if (!tx || typeof tx.to !== "string" || !tx.to) return null; // contract creation / malformed
  const vault = vaults.get(tx.to.toLowerCase());
  if (!vault) return null;
  const input = tx.input;
  if (typeof input !== "string" || !HEX_RE.test(input)) return null;
  if (input.slice(0, 10).toLowerCase() !== REQUEST_REDEEM_SELECTOR) return null;
  // 4-byte selector + one 32-byte word, hex-encoded with 0x prefix.
  if (input.length < 2 + 8 + 64 || (input.length - 2) % 2 !== 0) {
    log.warn("requestRedeem calldata too short, ignoring", { tx: tx.hash, len: input.length });
    return null;
  }
  if (typeof tx.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(tx.hash)) return null;
  if (typeof tx.from !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(tx.from)) return null;

  // Decode first uint256 exactly as bigint.
  const shares = BigInt("0x" + input.slice(10, 74));
  return {
    network: "Ethereum",
    vault,
    wallet: tx.from,
    txHash: tx.hash,
    shares,
    detectedAt: now,
  };
}

export type EthQuoteFn = (vault: EthereumVaultConfig, shares: bigint) => Promise<bigint>;

/** previewRedeem(shares) via eth_call on latest state. */
export function makePreviewRedeem(httpUrl: string, fetchImpl: typeof fetch = fetch): EthQuoteFn {
  let id = 0;
  return async (vault, shares) => {
    const data = VAULT_ABI.encodeFunctionData("previewRedeem", [shares]);
    const res = await fetchImpl(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "eth_call", params: [{ to: vault.address, data }, "latest"] }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`eth_call HTTP ${res.status}`);
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(`eth_call error: ${body.error.message ?? "unknown"}`);
    if (typeof body.result !== "string" || !HEX_RE.test(body.result) || body.result.length < 66) {
      throw new Error("eth_call returned invalid result");
    }
    const [assets] = VAULT_ABI.decodeFunctionResult("previewRedeem", body.result);
    return BigInt(assets as bigint);
  };
}

export class EthereumMonitor {
  private readonly vaults: Map<string, EthereumVaultConfig>;
  private readonly quote: EthQuoteFn;
  private ws: WebSocket | undefined;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly cfg: EthereumConfig,
    private readonly dedupe: DedupeCache,
    private readonly sink: AlertSink,
    quote?: EthQuoteFn,
  ) {
    this.vaults = new Map(cfg.vaults.map((v) => [v.addressLower, v]));
    this.quote = quote ?? makePreviewRedeem(cfg.httpUrl);
  }

  /** Runs the connect/reconnect loop until stop(). Never throws. */
  async start(): Promise<void> {
    log.info("monitor started", { vaults: this.cfg.vaults.length });
    let failures = 0;
    while (!this.stopped) {
      const connectedAt = Date.now();
      try {
        await this.runConnection();
      } catch (err) {
        if (!this.stopped) log.warn("websocket error", { err: errMsg(err) });
      }
      if (this.stopped) break;
      failures = Date.now() - connectedAt >= STABLE_CONNECTION_MS ? 1 : failures + 1;
      const base = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      log.warn("websocket disconnected, reconnecting", { inMs: delay, attempt: failures });
      try {
        await sleep(delay, undefined, { signal: this.abort.signal });
      } catch {
        break; // aborted by stop()
      }
    }
    log.info("monitor stopped");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.ws?.terminate();
    await Promise.allSettled([...this.inflight]);
  }

  /** One WebSocket session. Resolves when the socket closes. */
  private runConnection(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(this.cfg.wsUrl, { handshakeTimeout: CONNECT_TIMEOUT_MS });
      this.ws = ws;
      let subId: string | undefined;
      let pingTimer: NodeJS.Timeout | undefined;
      let pongTimer: NodeJS.Timeout | undefined;
      let subTimer: NodeJS.Timeout | undefined;

      ws.on("open", () => {
        log.info("WebSocket connected");
        const toAddress = this.cfg.vaults.map((v) => v.address);
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: SUBSCRIBE_ID,
            method: "eth_subscribe",
            params: ["alchemy_pendingTransactions", { toAddress, hashesOnly: false }],
          }),
        );
        subTimer = setTimeout(() => {
          log.warn("subscription not confirmed in time, reconnecting");
          ws.terminate();
        }, SUBSCRIBE_TIMEOUT_MS);
        pingTimer = setInterval(() => {
          ws.ping();
          clearTimeout(pongTimer);
          pongTimer = setTimeout(() => {
            log.warn("pong timeout, terminating socket");
            ws.terminate();
          }, PONG_TIMEOUT_MS);
        }, PING_INTERVAL_MS);
      });

      ws.on("pong", () => clearTimeout(pongTimer));

      ws.on("message", (data) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          log.warn("non-JSON websocket message ignored");
          return;
        }
        if (msg?.id === SUBSCRIBE_ID) {
          clearTimeout(subTimer);
          if (msg.error || typeof msg.result !== "string") {
            log.error("pending subscription rejected", { err: msg.error?.message ?? "no subscription id" });
            ws.close();
            return;
          }
          subId = msg.result;
          log.info("pending subscription active", { toAddress: this.cfg.vaults.length });
          return;
        }
        if (msg?.method === "eth_subscription" && subId && msg.params?.subscription === subId) {
          this.track(this.handlePendingTx(msg.params.result as PendingTx));
        }
      });

      ws.on("error", (err) => {
        log.warn("websocket error", { err: errMsg(err) });
      });
      ws.on("close", (code) => {
        log.debug("websocket closed", { code });
        clearInterval(pingTimer);
        clearTimeout(pongTimer);
        clearTimeout(subTimer);
        resolve();
      });
    });
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => undefined);
  }

  /** Decode, dedupe, quote and alert. Exposed for tests. Never throws. */
  async handlePendingTx(tx: PendingTx): Promise<RedeemAlert | null> {
    try {
      const req = parsePendingTx(tx, this.vaults);
      if (!req || req.shares === null) return null; // shares is always decoded on Ethereum
      if (!this.dedupe.checkAndMark(ethDedupeKey(req.txHash, req.vault.address))) {
        log.debug("duplicate pending tx suppressed", { tx: req.txHash });
        return null;
      }
      log.info("pending redeem detected", { tx: req.txHash, vault: req.vault.name, shares: req.shares });
      const vault = req.vault as EthereumVaultConfig;
      const assetAmountRaw = await this.quoteWithRetry(vault, req.shares, req.txHash);
      const alert: RedeemAlert = {
        network: "Ethereum",
        vaultName: vault.name,
        vaultAddress: vault.address,
        symbol: vault.symbol,
        decimals: vault.decimals,
        wallet: req.wallet,
        txHash: req.txHash,
        shares: req.shares,
        assetAmountRaw,
        detectedAt: req.detectedAt,
      };
      await this.sink.send(alert);
      return alert;
    } catch (err) {
      log.error("failed to process pending tx", { tx: tx?.hash, err: errMsg(err) });
      return null;
    }
  }

  private async quoteWithRetry(vault: EthereumVaultConfig, shares: bigint, txHash: string): Promise<bigint | null> {
    for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
      try {
        return await this.quote(vault, shares);
      } catch (err) {
        log.warn("previewRedeem failed", { tx: txHash, attempt, err: errMsg(err) });
        if (attempt < QUOTE_ATTEMPTS) await sleep(QUOTE_RETRY_DELAY_MS * attempt);
      }
    }
    log.error("previewRedeem unavailable, alerting with Amount: unavailable", { tx: txHash });
    return null;
  }
}
