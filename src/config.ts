import dotenv from "dotenv";
import { fromBech32 } from "@cosmjs/encoding";
import { getAddress, isAddress } from "ethers";
import type {
  AppConfig,
  EthereumVaultConfig,
  LogLevel,
  VaultConfig,
  ZigVaultConfig,
} from "./types";

const VAULT_FIELDS = ["NAME", "ADDRESS", "SYMBOL", "DECIMALS"] as const;
type VaultField = (typeof VAULT_FIELDS)[number];

export class ConfigError extends Error {}

function str(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? "").trim();
}

function required(env: NodeJS.ProcessEnv, key: string, errors: string[]): string {
  const v = str(env, key);
  if (!v) errors.push(`${key} is required`);
  return v;
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean, errors: string[]): boolean {
  const v = str(env, key).toLowerCase();
  if (!v) return def;
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  errors.push(`${key} must be true or false`);
  return def;
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number, errors: string[]): number {
  const v = str(env, key);
  if (!v) return def;
  if (!/^[0-9]+$/.test(v)) {
    errors.push(`${key} must be an integer`);
    return def;
  }
  const n = Number(v);
  if (n < min || n > max) {
    errors.push(`${key} must be between ${min} and ${max}`);
    return def;
  }
  return n;
}

function url(env: NodeJS.ProcessEnv, key: string, protocols: string[], errors: string[], optional = false): string {
  const v = optional ? str(env, key) : required(env, key, errors);
  if (!v) return "";
  try {
    const u = new URL(v);
    if (!protocols.includes(u.protocol)) errors.push(`${key} must use ${protocols.join(" or ")}`);
  } catch {
    errors.push(`${key} is not a valid URL`);
  }
  return v.replace(/\/+$/, "");
}

export function parseChatIds(raw: string, errors: string[]): string[] {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!/^-?[0-9]+$/.test(id) && !/^@[A-Za-z0-9_]{5,}$/.test(id)) {
      errors.push(`TELEGRAM_CHAT_IDS contains invalid chat id "${id}"`);
    }
  }
  return [...new Set(ids)];
}

/**
 * Discover numbered vault records (PREFIX_01_NAME, PREFIX_01_ADDRESS, ...).
 * Every record must define all fields; unknown fields are rejected so typos fail loudly.
 */
export function discoverVaults(env: NodeJS.ProcessEnv, prefix: "ETH_VAULT" | "ZIG_VAULT", errors: string[]): VaultConfig[] {
  const re = new RegExp(`^${prefix}_([0-9]+)_([A-Z_]+)$`);
  const groups = new Map<string, Partial<Record<VaultField, string>>>();
  for (const key of Object.keys(env)) {
    const m = re.exec(key);
    if (!m) continue;
    const [, id, field] = m as unknown as [string, string, string];
    if (!(VAULT_FIELDS as readonly string[]).includes(field)) {
      errors.push(`${key}: unknown vault field (expected ${VAULT_FIELDS.join(", ")})`);
      continue;
    }
    const g = groups.get(id) ?? {};
    const v = str(env, key);
    if (v) g[field as VaultField] = v;
    groups.set(id, g);
  }

  const vaults: VaultConfig[] = [];
  const ids = [...groups.keys()].sort((a, b) => Number(a) - Number(b));
  for (const id of ids) {
    const g = groups.get(id)!;
    const missing = VAULT_FIELDS.filter((f) => !g[f]);
    if (missing.length) {
      errors.push(`${prefix}_${id} is partially configured, missing: ${missing.map((f) => `${prefix}_${id}_${f}`).join(", ")}`);
      continue;
    }
    const decStr = g.DECIMALS!;
    if (!/^[0-9]+$/.test(decStr) || Number(decStr) > 36) {
      errors.push(`${prefix}_${id}_DECIMALS must be an integer 0..36`);
      continue;
    }
    vaults.push({ id, name: g.NAME!, address: g.ADDRESS!, symbol: g.SYMBOL!, decimals: Number(decStr) });
  }
  return vaults;
}

function validateEthVaults(vaults: VaultConfig[], errors: string[]): EthereumVaultConfig[] {
  const out: EthereumVaultConfig[] = [];
  const seen = new Set<string>();
  for (const v of vaults) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(v.address) || !isAddress(v.address)) {
      errors.push(`ETH_VAULT_${v.id}_ADDRESS is not a valid Ethereum address (bad format or checksum)`);
      continue;
    }
    const lower = v.address.toLowerCase();
    if (seen.has(lower)) {
      errors.push(`ETH_VAULT_${v.id}_ADDRESS duplicates another Ethereum vault address`);
      continue;
    }
    seen.add(lower);
    out.push({ ...v, network: "Ethereum", address: getAddress(v.address), addressLower: lower });
  }
  return out;
}

function validateZigVaults(vaults: VaultConfig[], errors: string[]): ZigVaultConfig[] {
  const out: ZigVaultConfig[] = [];
  const seen = new Set<string>();
  for (const v of vaults) {
    try {
      if (v.address !== v.address.toLowerCase()) throw new Error("must be lower-case");
      const { prefix } = fromBech32(v.address, 128);
      if (prefix !== "zig") throw new Error(`prefix "${prefix}" is not "zig"`);
    } catch (e) {
      errors.push(`ZIG_VAULT_${v.id}_ADDRESS is not a valid zig bech32 address: ${(e as Error).message}`);
      continue;
    }
    if (seen.has(v.address)) {
      errors.push(`ZIG_VAULT_${v.id}_ADDRESS duplicates another ZigChain vault address`);
      continue;
    }
    seen.add(v.address);
    out.push({ ...v, network: "ZigChain" });
  }
  return out;
}

export function buildConfig(env: NodeJS.ProcessEnv): AppConfig {
  const errors: string[] = [];

  const dryRun = bool(env, "DRY_RUN", true, errors);
  const botToken = str(env, "TELEGRAM_BOT_TOKEN");
  const chatIds = parseChatIds(str(env, "TELEGRAM_CHAT_IDS"), errors);
  if (!dryRun) {
    if (!botToken) errors.push("TELEGRAM_BOT_TOKEN is required when DRY_RUN=false");
    if (chatIds.length === 0) errors.push("TELEGRAM_CHAT_IDS must list at least one chat when DRY_RUN=false");
  }

  const ethVaults = validateEthVaults(discoverVaults(env, "ETH_VAULT", errors), errors);
  const zigVaults = validateZigVaults(discoverVaults(env, "ZIG_VAULT", errors), errors);
  if (ethVaults.length === 0 && zigVaults.length === 0) {
    errors.push("no vaults configured (need ETH_VAULT_01_* and/or ZIG_VAULT_01_*)");
  }

  const ethOptional = ethVaults.length === 0;
  const zigOptional = zigVaults.length === 0;

  const logLevelRaw = (str(env, "LOG_LEVEL") || "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) errors.push("LOG_LEVEL must be debug|info|warn|error");

  const cfg: AppConfig = {
    telegram: { botToken, chatIds, dryRun },
    ethereum: {
      wsUrl: url(env, "ETHEREUM_WS_URL", ["wss:", "ws:"], errors, ethOptional),
      httpUrl: url(env, "ETHEREUM_HTTP_URL", ["https:", "http:"], errors, ethOptional),
      vaults: ethVaults,
    },
    zigchain: {
      rpcUrl: url(env, "ZIGCHAIN_RPC_URL", ["https:", "http:"], errors, zigOptional),
      wsUrl: url(env, "ZIGCHAIN_WS_URL", ["wss:", "ws:"], errors, true),
      lcdUrl: url(env, "ZIGCHAIN_LCD_URL", ["https:", "http:"], errors, true),
      pollMs: int(env, "ZIG_MEMPOOL_POLL_MS", 500, 100, 60_000, errors),
      vaults: zigVaults,
    },
    dedupeTtlMs: int(env, "DEDUPE_TTL_MINUTES", 1440, 1, 60 * 24 * 30, errors) * 60_000,
    alertExistingMempoolOnStart: bool(env, "ALERT_EXISTING_MEMPOOL_ON_START", false, errors),
    logLevel: logLevelRaw as LogLevel,
  };

  if (errors.length) throw new ConfigError(`invalid configuration:\n  - ${errors.join("\n  - ")}`);
  return cfg;
}

export function loadConfig(): AppConfig {
  dotenv.config({ quiet: true });
  return buildConfig(process.env);
}

/** Non-secret summary for startup logging. */
export function describeConfig(cfg: AppConfig): Record<string, unknown> {
  return {
    dryRun: cfg.telegram.dryRun,
    chats: cfg.telegram.chatIds.length,
    tokenSet: cfg.telegram.botToken.length > 0,
    ethVaults: cfg.ethereum.vaults.map((v) => `${v.name}(${v.address})`),
    zigVaults: cfg.zigchain.vaults.map((v) => `${v.name}(${v.address})`),
    zigPollMs: cfg.zigchain.pollMs,
    zigQuoteVia: cfg.zigchain.lcdUrl ? "lcd" : "rpc-abci",
    dedupeTtlMin: cfg.dedupeTtlMs / 60_000,
    alertExistingMempoolOnStart: cfg.alertExistingMempoolOnStart,
  };
}
