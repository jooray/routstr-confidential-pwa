// The amount a BOLT 11 invoice asks for, read from its human-readable part
// (`ln` + network + amount + multiplier, BOLT 11 "Human-Readable Part"). The
// node hands the page the invoice; the page checks that it asks for what the
// user entered before it shows it to be paid.

const MSAT_PER_UNIT: Record<string, bigint> = { "": 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n };

/**
 * The invoice's amount in msat; `undefined` for an invoice without one;
 * `null` when the text is not a BOLT 11 invoice in the bech32 alphabet (the
 * only characters a QR code in alphanumeric mode can hold, upper-cased).
 */
export function bolt11AmountMsat(invoice: string): bigint | undefined | null {
  const s = invoice.trim().toLowerCase();
  // bech32: the separator is the last "1"; the data part uses no "1", "b", "i" or "o".
  const sep = s.lastIndexOf("1");
  if (sep < 4 || s.length > 2000 || !/^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/.test(s.slice(sep + 1))) return null;
  const m = /^ln([a-z]+?)(\d*)([munp]?)$/.exec(s.slice(0, sep));
  if (!m) return null;
  const [, , digits, unit] = m;
  if (!digits) return unit ? null : undefined;
  // No leading zeros (BOLT 11), and a pico amount must be whole msat.
  if (digits.length > 1 && digits.startsWith("0")) return null;
  const n = BigInt(digits);
  if (unit === "p") return n % 10n === 0n ? n / 10n : null;
  return n * MSAT_PER_UNIT[unit!]!;
}
