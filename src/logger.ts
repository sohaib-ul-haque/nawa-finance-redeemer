import type { LogLevel } from "./types";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();
let currentLevel: LogLevel = "info";

/** Telegram bot token shape, redacted even if never registered. */
const TG_TOKEN_RE = /(?<![0-9])\d{6,}:[A-Za-z0-9_-]{30,}/g;
/** Alchemy-style API key in URL path. */
const ALCHEMY_KEY_RE = /(alchemy\.com\/v2\/)[^\s"'/?]+/gi;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Register a value that must never appear in logs. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("***");
  return out.replace(TG_TOKEN_RE, "***").replace(ALCHEMY_KEY_RE, "$1***");
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : "";
    return redact(`${err.name}: ${err.message}${causeMsg}`);
  }
  return redact(String(err));
}

function write(level: LogLevel, tag: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (fields) {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === "bigint" ? v.toString() : typeof v === "string" ? v : JSON.stringify(v)}`);
    if (parts.length) line += " " + parts.join(" ");
  }
  line = redact(line);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(tag: string): Logger {
  return {
    debug: (m, f) => write("debug", tag, m, f),
    info: (m, f) => write("info", tag, m, f),
    warn: (m, f) => write("warn", tag, m, f),
    error: (m, f) => write("error", tag, m, f),
  };
}
