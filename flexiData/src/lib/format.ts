export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function money(amount: number, opts?: { sign?: boolean }): string {
  const abs = Math.abs(amount);
  const str = abs.toLocaleString("en-GH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (opts?.sign) {
    return `${amount < 0 ? "−" : "+"} GH₵ ${str}`;
  }
  return `GH₵ ${str}`;
}

export function groupPhone(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 7)} ${d.slice(7)}`;
}

export function phoneDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

/** Normalize any Ghanaian number input (0XX, 233XX, or 9-digit) to 0XXXXXXXXX. */
export function normalizePhoneDigits(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return `0${digits.slice(3)}`;
  if (digits.length === 10 && digits.startsWith("0")) return digits;
  if (digits.length === 9) return `0${digits}`;
  return digits.slice(0, 10);
}

export function isValidPhone(digits: string): boolean {
  return /^\d{9,10}$/.test(digits);
}

export function toGhanaMsisdn(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.startsWith("233") && digits.length === 12) return digits;
  if (digits.startsWith("0") && digits.length === 10) return `233${digits.slice(1)}`;
  if (digits.length === 9) return `233${digits}`;
  return digits;
}

export function fmtPoints(n: number): string {
  return n.toLocaleString("en-GH");
}

const DAY = 86400000;

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 2 * DAY) return "Yesterday";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - DAY);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest)) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function makeRef(prefix = "FD"): string {
  const t = Date.now().toString(36).toUpperCase();
  const r = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${t}${r}`;
}

export function makeReferralCode(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}
