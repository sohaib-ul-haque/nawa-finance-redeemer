import { setTimeout as sleep } from "node:timers/promises";
import { formatDisplayAmount } from "./amount";
import { createLogger, errMsg } from "./logger";
import type { AlertSink, RedeemAlert, TelegramConfig } from "./types";

const log = createLogger("TG");

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 30_000;

/** "2026-10-17 12:45:57 UTC" */
export function formatUtc(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Exact alert text. Sent as plain text (no parse_mode), so no Markdown/HTML
 * escaping is needed and on-chain strings cannot inject formatting.
 */
export function formatAlert(a: RedeemAlert): string {
  const amount =
    a.assetAmountRaw === null ? "unavailable" : `${formatDisplayAmount(a.assetAmountRaw, a.decimals)} ${a.symbol}`;
  return [
    "🚨 Withdrawal Request Detected",
    "",
    `Vault: ${a.vaultName}`,
    `Network: ${a.network}`,
    "",
    `Wallet: ${a.wallet}`,
    `Amount: ${amount}`,
    `Timestamp: ${formatUtc(a.detectedAt)}`,
    "",
    "Status: Pending Redeem Request",
    `Tx: ${a.txHash}`,
  ].join("\n");
}

class PermanentError extends Error {}
class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

export class TelegramNotifier implements AlertSink {
  constructor(
    private readonly cfg: TelegramConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(alert: RedeemAlert): Promise<void> {
    const text = formatAlert(alert);
    if (this.cfg.dryRun) {
      log.info(`DRY_RUN alert (not sent) tx=${alert.txHash}\n${text}`);
      return;
    }
    // Fan out to all chats; one failing chat never affects the others.
    const results = await Promise.allSettled(this.cfg.chatIds.map((chat) => this.sendToChat(chat, text)));
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        log.error("alert failed for chat", { chat: this.cfg.chatIds[i], tx: alert.txHash, err: errMsg(r.reason) });
      }
    });
  }

  private async sendToChat(chatId: string, text: string): Promise<void> {
    let delay = 1_000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.postMessage(chatId, text);
        log.info("alert sent", { chat: chatId });
        return;
      } catch (err) {
        if (err instanceof PermanentError || attempt === MAX_ATTEMPTS) throw err;
        const wait = err instanceof RetryableError && err.retryAfterMs ? err.retryAfterMs : delay;
        log.warn("send failed, retrying", { chat: chatId, attempt, waitMs: wait, err: errMsg(err) });
        await sleep(wait);
        delay = Math.min(delay * 2, 8_000);
      }
    }
  }

  private async postMessage(chatId: string, text: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.cfg.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error / timeout. Message is re-created so the URL (with token) can never leak.
      throw new RetryableError(`network error: ${errMsg(err)}`);
    }
    let body: { ok?: boolean; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON body */
    }
    if (res.ok && body.ok) return;
    const desc = `HTTP ${res.status}: ${body.description ?? "unknown error"}`;
    if (res.status === 429) {
      const ra = Math.min((body.parameters?.retry_after ?? 1) * 1000, MAX_RETRY_AFTER_MS);
      throw new RetryableError(desc, ra);
    }
    if (res.status >= 500) throw new RetryableError(desc);
    throw new PermanentError(desc);
  }
}

export const START_REPLY =
  "✅ NAWA Finance Redeemer Bot is running.\n\nMonitoring Ethereum and ZigChain pending redeem requests.";

const POLL_TIMEOUT_S = 30;
const POLL_FETCH_TIMEOUT_MS = (POLL_TIMEOUT_S + 10) * 1000;
const POLL_BACKOFF_BASE_MS = 1_000;
const POLL_BACKOFF_MAX_MS = 60_000;
const REPLY_ATTEMPTS = 3;

interface TgUpdate {
  update_id: number;
  message?: { chat?: { id?: number | string }; text?: string };
}

/** True for "/start", "/start@BotName" and "/start <payload>". */
export function isStartCommand(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const cmd = text.trim().split(/\s+/, 1)[0] ?? "";
  return cmd === "/start" || /^\/start@[A-Za-z0-9_]+$/.test(cmd);
}

/**
 * Minimal getUpdates long-polling loop that only answers /start.
 * Sequential, offset-tracked, bounded backoff; runs independently of the chain monitors.
 */
export class TelegramCommandPoller {
  private offset = 0;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Runs until stop(). Never throws. */
  async start(): Promise<void> {
    log.info("command polling started");
    let failures = 0;
    while (!this.stopped) {
      try {
        const updates = await this.getUpdates();
        failures = 0;
        for (const u of updates) await this.handleUpdate(u);
        continue;
      } catch (err) {
        if (this.stopped) break;
        failures++;
        const delay = Math.min(POLL_BACKOFF_BASE_MS * 2 ** (failures - 1), POLL_BACKOFF_MAX_MS);
        log.warn("getUpdates failed, retrying", { attempt: failures, inMs: delay, err: errMsg(err) });
        try {
          await sleep(delay, undefined, { signal: this.abort.signal });
        } catch {
          break;
        }
      }
    }
    log.info("command polling stopped");
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
  }

  private async getUpdates(): Promise<TgUpdate[]> {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offset: this.offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] }),
      signal: AbortSignal.any([AbortSignal.timeout(POLL_FETCH_TIMEOUT_MS), this.abort.signal]),
    }).catch((err: unknown) => {
      throw new Error(`network error: ${errMsg(err)}`); // never surface the URL
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string };
    if (!res.ok || !body.ok || !Array.isArray(body.result)) {
      throw new Error(`getUpdates HTTP ${res.status}: ${body.description ?? "unknown error"}`);
    }
    return body.result as TgUpdate[];
  }

  /** Handle one update. Updates at or below the processed offset are ignored. Exposed for tests. */
  async handleUpdate(u: TgUpdate): Promise<boolean> {
    if (!u || !Number.isSafeInteger(u.update_id) || u.update_id < this.offset) return false;
    this.offset = u.update_id + 1;
    const chatId = u.message?.chat?.id;
    if (chatId === undefined || !isStartCommand(u.message?.text)) return false;
    await this.reply(String(chatId), START_REPLY);
    return true;
  }

  private async reply(chatId: string, text: string): Promise<void> {
    for (let attempt = 1; attempt <= REPLY_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (res.ok) {
          log.info("/start reply sent", { chat: chatId });
          return;
        }
        if (res.status < 500 && res.status !== 429) {
          log.warn("/start reply rejected", { chat: chatId, status: res.status });
          return;
        }
        log.warn("/start reply failed", { chat: chatId, attempt, status: res.status });
      } catch (err) {
        log.warn("/start reply failed", { chat: chatId, attempt, err: errMsg(err) });
      }
      if (attempt < REPLY_ATTEMPTS && !this.stopped) await sleep(1_000 * attempt);
    }
  }
}
