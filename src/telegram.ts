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
