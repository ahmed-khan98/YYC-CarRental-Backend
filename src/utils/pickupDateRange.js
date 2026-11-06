const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function asYmd(value) {
  if (typeof value !== "string") return "";
  const key = value.trim().slice(0, 10);
  return YMD_RE.test(key) ? key : "";
}

export function nextYmd(ymd) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function pickupDateRangeMatch(from, to) {
  const start = asYmd(from);
  const end = asYmd(to);
  if (!start && !end) return null;
  const range = {};
  if (start) range.$gte = start;
  if (end) range.$lt = nextYmd(end);
  return { pickupDate: range };
}
