import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { MsgExecuteContract } from "cosmjs-types/cosmwasm/wasm/v1/tx";
import { QuerySmartContractStateRequest, QuerySmartContractStateResponse } from "cosmjs-types/cosmwasm/wasm/v1/query";
import { parseRawAmount } from "./amount";
import { DedupeCache, zigDedupeKey } from "./dedupe";
import { createLogger, errMsg } from "./logger";
import type { AlertSink, RawRedeemRequest, RedeemAlert, ZigChainConfig, ZigVaultConfig } from "./types";

const log = createLogger("ZIG");

export const MSG_EXECUTE_CONTRACT_TYPE_URL = "/cosmwasm.wasm.v1.MsgExecuteContract";
export const REDEEM_ACTION = "request_redeem";

/** CometBFT caps /unconfirmed_txs page size at 100. */
const MEMPOOL_LIMIT = 100;
const RPC_TIMEOUT_MS = 5_000;
const POLL_BACKOFF_BASE_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 30_000;
const SUMMARY_INTERVAL_MS = 60_000;
const QUOTE_ATTEMPTS = 3;
const QUOTE_RETRY_DELAY_MS = 750;
const WS_BACKOFF_MAX_MS = 60_000;
const WS_STABLE_MS = 60_000;
const BLOCK_STALL_WARN_MS = 60_000;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Tendermint/CometBFT tx hash: upper-case hex SHA-256 of the raw tx bytes. */
export function cometTxHash(rawTx: Uint8Array): string {
  return createHash("sha256").update(rawTx).digest("hex").toUpperCase();
}

/** Returns true only for a JSON object whose sole key is exactly "request_redeem" with an object value. */
export function isRequestRedeemMsg(msgBytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8.decode(msgBytes));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== REDEEM_ACTION) return false;
  const inner = (parsed as Record<string, unknown>)[REDEEM_ACTION];
  return !!inner && typeof inner === "object" && !Array.isArray(inner);
}

/**
 * Pick the share amount from funds. The vault share token is a factory denom
 * "coin.<vault>.<subdenom>". If none matches but exactly one coin is attached,
 * that coin is used (it is the only thing the user is redeeming). Otherwise null.
 */
export function extractShares(funds: { denom: string; amount: string }[], vaultAddress: string): bigint | null {
  const prefix = `coin.${vaultAddress}.`;
  const matching = funds.filter((c) => c.denom.startsWith(prefix));
  const pick = matching.length === 1 ? matching[0] : matching.length === 0 && funds.length === 1 ? funds[0] : undefined;
  if (!pick) return null;
  if (matching.length === 0) log.warn("request_redeem funds denom is not a vault share denom", { denom: pick.denom });
  try {
    return parseRawAmount(pick.amount);
  } catch {
    return null;
  }
}

export interface DecodedMempoolTx {
  txHash: string;
  requests: RawRedeemRequest[];
}

/** Base64 -> TxRaw -> TxBody -> Any[] -> MsgExecuteContract, filtered to configured vault request_redeem. */
export function decodeMempoolTx(
  b64: string,
  vaults: ReadonlyMap<string, ZigVaultConfig>,
  now: Date = new Date(),
): DecodedMempoolTx {
  if (typeof b64 !== "string" || !BASE64_RE.test(b64) || b64.length % 4 !== 0) throw new Error("tx is not valid base64");
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const txHash = cometTxHash(bytes);
  const raw = TxRaw.decode(bytes);
  const body = TxBody.decode(raw.bodyBytes);
  const requests: RawRedeemRequest[] = [];
  body.messages.forEach((any, messageIndex) => {
    if (any.typeUrl !== MSG_EXECUTE_CONTRACT_TYPE_URL) return;
    let msg: MsgExecuteContract;
    try {
      msg = MsgExecuteContract.decode(any.value);
    } catch {
      return;
    }
    const vault = vaults.get(msg.contract);
    if (!vault) return;
    if (!isRequestRedeemMsg(msg.msg)) return;
    requests.push({
      network: "ZigChain",
      vault,
      wallet: msg.sender,
      txHash,
      shares: extractShares(msg.funds, vault.address),
      messageIndex,
      detectedAt: now,
    });
  });
  return { txHash, requests };
}

export type ZigQuoteFn = (vault: ZigVaultConfig, shares: bigint) => Promise<bigint>;

/**
 * CosmWasm smart query transport. Uses LCD REST if ZIGCHAIN_LCD_URL is set,
 * otherwise CometBFT RPC abci_query (/cosmwasm.wasm.v1.Query/SmartContractState),
 * which was verified to work on the configured RPC. Returns parsed JSON response.
 */
export function makeSmartQuery(cfg: Pick<ZigChainConfig, "rpcUrl" | "lcdUrl">, fetchImpl: typeof fetch = fetch) {
  return async (contract: string, query: unknown): Promise<unknown> => {
    const queryBytes = new TextEncoder().encode(JSON.stringify(query));
    if (cfg.lcdUrl) {
      const q = encodeURIComponent(Buffer.from(queryBytes).toString("base64"));
      const res = await fetchImpl(`${cfg.lcdUrl}/cosmwasm/wasm/v1/contract/${contract}/smart/${q}`, {
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`smart query HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown };
      if (body.data === undefined) throw new Error("smart query: no data");
      return body.data;
    }
    const req = QuerySmartContractStateRequest.encode({ address: contract, queryData: queryBytes }).finish();
    const path = encodeURIComponent('"/cosmwasm.wasm.v1.Query/SmartContractState"');
    const res = await fetchImpl(`${cfg.rpcUrl}/abci_query?path=${path}&data=0x${Buffer.from(req).toString("hex")}`, {
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`abci_query HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { response?: { code?: number; log?: string; value?: string | null } };
      error?: { message?: string; data?: string };
    };
    if (body.error) throw new Error(`abci_query error: ${body.error.data ?? body.error.message ?? "unknown"}`);
    const r = body.result?.response;
    if (!r) throw new Error("abci_query: missing response");
    if (r.code) throw new Error(`abci_query code ${r.code}: ${r.log ?? ""}`);
    if (!r.value) throw new Error("abci_query: empty value");
    const decoded = QuerySmartContractStateResponse.decode(Buffer.from(r.value, "base64"));
    return JSON.parse(utf8.decode(decoded.data));
  };
}

/** redemption_quote { shares } -> asset_value (raw underlying units). */
export function makeRedemptionQuote(smartQuery: ReturnType<typeof makeSmartQuery>): ZigQuoteFn {
  return async (vault, shares) => {
    const resp = (await smartQuery(vault.address, { redemption_quote: { shares: shares.toString() } })) as {
      shares?: unknown;
      asset_value?: unknown;
    };
    if (typeof resp?.asset_value !== "string") throw new Error("redemption_quote: missing asset_value");
    if (typeof resp.shares === "string" && resp.shares !== shares.toString()) {
      throw new Error(`redemption_quote: shares mismatch (${resp.shares} != ${shares})`);
    }
    return parseRawAmount(resp.asset_value);
  };
}

export class ZigChainMonitor {
  private readonly vaults: Map<string, ZigVaultConfig>;
  private readonly quote: ZigQuoteFn;
  /** Tx-level cache: each mempool tx is decoded once; also holds the startup baseline. */
  private readonly txSeen: DedupeCache;
  private baselineDone = false;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private ws: WebSocket | undefined;
  private lastSummaryAt = 0;
  private lastTruncWarnAt = 0;

  constructor(
    private readonly cfg: ZigChainConfig,
    private readonly dedupe: DedupeCache,
    private readonly sink: AlertSink,
    private readonly opts: { alertExistingOnStart: boolean; dedupeTtlMs: number },
    quote?: ZigQuoteFn,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.vaults = new Map(cfg.vaults.map((v) => [v.address, v]));
    this.quote = quote ?? makeRedemptionQuote(makeSmartQuery(cfg, fetchImpl));
    this.txSeen = new DedupeCache(opts.dedupeTtlMs, 200_000);
  }

  async start(): Promise<void> {
    this.txSeen.startSweeper();
    const tasks: Promise<void>[] = [this.pollLoop()];
    if (this.cfg.wsUrl) tasks.push(this.wsLoop());
    await Promise.all(tasks);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    this.ws?.terminate();
    this.txSeen.stopSweeper();
    await Promise.allSettled([...this.inflight]);
  }

  private async sleep(ms: number): Promise<boolean> {
    try {
      await sleep(ms, undefined, { signal: this.abort.signal });
      return true;
    } catch {
      return false;
    }
  }

  /** Single sequential loop: await poll -> await sleep. Requests can never overlap. */
  private async pollLoop(): Promise<void> {
    log.info("mempool monitor started", { pollMs: this.cfg.pollMs, vaults: this.cfg.vaults.length });
    let failures = 0;
    while (!this.stopped) {
      try {
        const txs = await this.fetchMempool();
        if (failures > 0) log.info("rpc recovered", { afterFailures: failures });
        failures = 0;
        this.processMempool(txs);
      } catch (err) {
        if (this.stopped) break;
        failures++;
        const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        log.warn(isTimeout ? "rpc timeout, retrying" : "mempool poll failed, retrying", {
          attempt: failures,
          err: errMsg(err),
        });
      }
      const delay =
        failures === 0 ? this.cfg.pollMs : Math.min(POLL_BACKOFF_BASE_MS * 2 ** (failures - 1), POLL_BACKOFF_MAX_MS);
      if (!(await this.sleep(delay))) break;
    }
    log.info("mempool monitor stopped");
  }

  private async fetchMempool(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.cfg.rpcUrl}/unconfirmed_txs?limit=${MEMPOOL_LIMIT}`, {
      signal: AbortSignal.any([AbortSignal.timeout(RPC_TIMEOUT_MS), this.abort.signal]),
    });
    if (!res.ok) throw new Error(`unconfirmed_txs HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { n_txs?: string; total?: string; txs?: string[] | null };
      error?: { message?: string };
    };
    if (body.error) throw new Error(`unconfirmed_txs error: ${body.error.message ?? "unknown"}`);
    if (!body.result) throw new Error("unconfirmed_txs: missing result");
    const txs = body.result.txs ?? [];
    if (!Array.isArray(txs)) throw new Error("unconfirmed_txs: txs is not an array");
    const total = Number(body.result.total ?? txs.length);
    if (total > txs.length && Date.now() - this.lastTruncWarnAt > SUMMARY_INTERVAL_MS) {
      this.lastTruncWarnAt = Date.now();
      log.warn("mempool larger than one page; only first page is visible", { returned: txs.length, total });
    }
    return txs;
  }

  /** Process one mempool snapshot. Exposed for tests. */
  processMempool(txs: string[]): void {
    const now = Date.now();
    if (!this.baselineDone || now - this.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      this.lastSummaryAt = now;
      log.info(`mempool contains ${txs.length} txs`);
    } else {
      log.debug(`mempool contains ${txs.length} txs`);
    }

    if (!this.baselineDone) {
      this.baselineDone = true;
      if (!this.opts.alertExistingOnStart) {
        for (const b64 of txs) this.txSeen.checkAndMark(b64TxKey(b64));
        log.info("startup baseline established, existing mempool txs will not alert", { baseline: txs.length });
        return;
      }
      log.info("ALERT_EXISTING_MEMPOOL_ON_START=true, processing existing mempool txs");
    }

    for (const b64 of txs) {
      if (!this.txSeen.checkAndMark(b64TxKey(b64))) continue;
      let decoded: DecodedMempoolTx;
      try {
        decoded = decodeMempoolTx(b64, this.vaults);
      } catch (err) {
        log.debug("undecodable mempool tx skipped", { err: errMsg(err) });
        continue;
      }
      for (const req of decoded.requests) this.track(this.handleRequest(req));
    }
  }

  /** Wait for all in-flight alerts (tests / shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  private track(p: Promise<unknown>): void {
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => undefined);
  }

  private async handleRequest(req: RawRedeemRequest): Promise<void> {
    try {
      const key = zigDedupeKey(req.txHash, req.messageIndex ?? 0, req.vault.address);
      if (!this.dedupe.checkAndMark(key)) return;
      log.info("pending redeem detected", {
        tx: req.txHash,
        msg: req.messageIndex,
        vault: req.vault.name,
        shares: req.shares ?? "unknown",
      });
      const vault = req.vault as ZigVaultConfig;
      let assetAmountRaw: bigint | null = null;
      if (req.shares === null) log.error("could not determine share amount from funds", { tx: req.txHash });
      else assetAmountRaw = await this.quoteWithRetry(vault, req.shares, req.txHash);
      const alert: RedeemAlert = {
        network: "ZigChain",
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
    } catch (err) {
      log.error("failed to process redeem request", { tx: req.txHash, err: errMsg(err) });
    }
  }

  private async quoteWithRetry(vault: ZigVaultConfig, shares: bigint, txHash: string): Promise<bigint | null> {
    for (let attempt = 1; attempt <= QUOTE_ATTEMPTS; attempt++) {
      try {
        return await this.quote(vault, shares);
      } catch (err) {
        log.warn("redemption_quote failed", { tx: txHash, attempt, err: errMsg(err) });
        if (attempt < QUOTE_ATTEMPTS) await sleep(QUOTE_RETRY_DELAY_MS * attempt);
      }
    }
    log.error("redemption_quote unavailable, alerting with Amount: unavailable", { tx: txHash });
    return null;
  }

  /** Liveness only: NewBlockHeader subscription. Not used for pending detection. */
  private async wsLoop(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      const startedAt = Date.now();
      await this.runWs().catch((err) => log.warn("websocket error", { err: errMsg(err) }));
      if (this.stopped) break;
      failures = Date.now() - startedAt >= WS_STABLE_MS ? 1 : failures + 1;
      const delay = Math.min(1_000 * 2 ** (failures - 1), WS_BACKOFF_MAX_MS);
      log.warn("websocket disconnected, reconnecting", { inMs: delay, attempt: failures });
      if (!(await this.sleep(delay))) break;
    }
  }

  private runWs(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ws = new WebSocket(this.cfg.wsUrl, { handshakeTimeout: 15_000 });
      this.ws = ws;
      let lastBlockAt = Date.now();
      let stallWarned = false;
      let lastHeight = "";
      const timer = setInterval(() => {
        if (Date.now() - lastBlockAt > BLOCK_STALL_WARN_MS) {
          if (!stallWarned) log.warn("no new block seen via websocket, reconnecting", { lastHeight });
          stallWarned = true;
          ws.terminate();
        }
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 15_000);

      ws.on("open", () => {
        log.info("WebSocket connected (liveness)");
        lastBlockAt = Date.now();
        ws.send(
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscribe", params: { query: "tm.event='NewBlockHeader'" } }),
        );
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as any;
          if (msg.error) {
            log.warn("websocket subscribe error", { err: msg.error.data ?? msg.error.message });
            return;
          }
          const height = msg?.result?.data?.value?.header?.height;
          if (typeof height === "string") {
            lastBlockAt = Date.now();
            lastHeight = height;
            log.debug("new block", { height });
          }
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on("error", (err) => log.debug("websocket error event", { err: errMsg(err) }));
      ws.on("close", () => {
        clearInterval(timer);
        resolve();
      });
    });
  }
}

function b64TxKey(b64: string): string {
  // Raw tx bytes uniquely identify the tx; hashing keeps memory bounded per entry.
  return createHash("sha256").update(b64).digest("base64");
}
