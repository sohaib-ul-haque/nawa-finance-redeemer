import { ConfigError, describeConfig, loadConfig } from "./config";
import { DedupeCache } from "./dedupe";
import { EthereumMonitor } from "./ethereum";
import { createLogger, errMsg, registerSecret, setLogLevel } from "./logger";
import { TelegramCommandPoller, TelegramNotifier } from "./telegram";
import { ZigChainMonitor } from "./zigchain";
import type { AppConfig } from "./types";

const log = createLogger("APP");
const SHUTDOWN_TIMEOUT_MS = 15_000;

function registerSecrets(cfg: AppConfig): void {
  registerSecret(cfg.telegram.botToken);
  // RPC URLs may embed API keys; never print them verbatim.
  for (const u of [cfg.ethereum.wsUrl, cfg.ethereum.httpUrl, cfg.zigchain.rpcUrl, cfg.zigchain.wsUrl, cfg.zigchain.lcdUrl]) {
    if (!u) continue;
    try {
      const { pathname, search, username, password } = new URL(u);
      for (const seg of pathname.split("/")) if (seg.length >= 16) registerSecret(seg);
      registerSecret(search.slice(1));
      registerSecret(username);
      registerSecret(password);
    } catch {
      /* validated in config */
    }
  }
}

async function main(): Promise<void> {
  let cfg: AppConfig;
  try {
    cfg = loadConfig();
  } catch (err) {
    log.error(err instanceof ConfigError ? err.message : `failed to load config: ${errMsg(err)}`);
    process.exit(1);
  }
  setLogLevel(cfg.logLevel);
  registerSecrets(cfg);
  log.info("starting nawa-finance-redeemer", describeConfig(cfg));
  if (cfg.telegram.dryRun) log.warn("DRY_RUN=true: alerts are printed to logs and NOT sent to Telegram");

  const dedupe = new DedupeCache(cfg.dedupeTtlMs);
  dedupe.startSweeper();
  const notifier = new TelegramNotifier(cfg.telegram);

  const monitors: { name: string; stop(): Promise<void>; run: Promise<void> }[] = [];

  if (cfg.ethereum.vaults.length) {
    const eth = new EthereumMonitor(cfg.ethereum, dedupe, notifier);
    monitors.push({ name: "ETH", stop: () => eth.stop(), run: eth.start() });
  } else {
    log.info("no Ethereum vaults configured, Ethereum monitor disabled");
  }

  if (cfg.zigchain.vaults.length) {
    const zig = new ZigChainMonitor(cfg.zigchain, dedupe, notifier, {
      alertExistingOnStart: cfg.alertExistingMempoolOnStart,
      dedupeTtlMs: cfg.dedupeTtlMs,
    });
    monitors.push({ name: "ZIG", stop: () => zig.stop(), run: zig.start() });
  } else {
    log.info("no ZigChain vaults configured, ZigChain monitor disabled");
  }

  if (!cfg.telegram.dryRun && cfg.telegram.botToken) {
    // Isolated from the chain monitors: its failures only back off and retry.
    const poller = new TelegramCommandPoller(cfg.telegram.botToken);
    monitors.push({ name: "TG", stop: async () => poller.stop(), run: poller.start() });
  }

  // Monitors loop internally and never reject; this is a last-resort guard.
  for (const m of monitors) m.run.catch((err) => log.error(`${m.name} monitor crashed`, { err: errMsg(err) }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    const force = setTimeout(() => {
      log.warn("shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await Promise.allSettled(monitors.map((m) => m.stop()));
    await Promise.allSettled(monitors.map((m) => m.run));
    dedupe.stopSweeper();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { err: errMsg(reason) }));
process.on("uncaughtException", (err) => {
  log.error("uncaught exception, exiting", { err: errMsg(err) });
  process.exit(1);
});

void main();
