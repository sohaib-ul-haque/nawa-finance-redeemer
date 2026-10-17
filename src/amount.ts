/**
 * Exact integer amount handling. Raw on-chain values are bigint only;
 * no floating point is used anywhere in this module.
 */

const UINT_RE = /^[0-9]+$/;

/** Parse a non-negative integer string (e.g. Cosmos coin amount) into bigint. */
export function parseRawAmount(value: string): bigint {
  if (typeof value !== "string" || !UINT_RE.test(value)) {
    throw new Error(`invalid raw amount: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new Error(`invalid decimals: ${decimals}`);
  }
}

/** Exact full-precision decimal string, e.g. 304381133898n,6 -> "304381.133898". */
export function toExactDecimal(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (raw < 0n) throw new Error("negative amount");
  if (decimals === 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

function withCommas(intPart: bigint): string {
  return intPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Display value with exactly 2 decimals, round-half-up, comma thousands separators.
 * 304381133898n,6 -> "304,381.13"; 20659286n,6 -> "20.66"; 0n -> "0.00".
 */
export function formatDisplayAmount(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (raw < 0n) throw new Error("negative amount");
  // Express value in hundredths (cents), rounding half-up.
  let cents: bigint;
  if (decimals >= 2) {
    const div = 10n ** BigInt(decimals - 2);
    cents = raw / div;
    const rem = raw % div;
    if (div > 1n && rem * 2n >= div) cents += 1n;
  } else {
    cents = raw * 10n ** BigInt(2 - decimals);
  }
  const whole = cents / 100n;
  const frac = (cents % 100n).toString().padStart(2, "0");
  return `${withCommas(whole)}.${frac}`;
}
