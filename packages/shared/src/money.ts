/**
 * Money is a decimal string with at most 2 fractional digits, e.g. "899.00".
 * Internally we work in integer cents (bigint) so sums are exact.
 * RLUSD on XRPL is an IOU whose value is a decimal string, so this maps 1:1.
 */

const MONEY_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

export type Money = string;

export function toCents(m: Money): bigint {
  const match = MONEY_RE.exec(m.trim());
  if (!match) throw new Error(`invalid money string: ${JSON.stringify(m)}`);
  const whole = match[1]!;
  const frac = (match[2] ?? "").padEnd(2, "0");
  return BigInt(whole) * 100n + BigInt(frac);
}

export function fromCents(c: bigint): Money {
  if (c < 0n) throw new Error("negative money not allowed");
  const whole = c / 100n;
  const frac = c % 100n;
  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

export function normalize(m: Money): Money {
  return fromCents(toCents(m));
}

export function add(...ms: Money[]): Money {
  return fromCents(ms.reduce((acc, m) => acc + toCents(m), 0n));
}

export function sub(a: Money, b: Money): Money {
  const r = toCents(a) - toCents(b);
  if (r < 0n) throw new Error(`money underflow: ${a} - ${b}`);
  return fromCents(r);
}

export function eq(a: Money, b: Money): boolean {
  return toCents(a) === toCents(b);
}

export function lt(a: Money, b: Money): boolean {
  return toCents(a) < toCents(b);
}

export function lte(a: Money, b: Money): boolean {
  return toCents(a) <= toCents(b);
}

export function isMoney(v: unknown): v is Money {
  return typeof v === "string" && MONEY_RE.test(v.trim());
}
