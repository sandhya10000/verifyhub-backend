// Business-day helpers pinned to Asia/Kolkata (IST, +05:30, no DST).
//
// Why this exists: MongoDB stores `createdAt` in UTC, but the business day is
// defined in IST. Building day/month windows with `new Date(y, m, d, ...)`
// uses the Node server's local timezone (usually UTC on cloud hosts), so
// "today" becomes 05:30 IST → 05:29 IST. Late-night transactions (e.g. a
// 02:50 IST recharge) then fall out of the window when the UTC clock rolls
// over, and dashboards show ₹0. Always compute boundaries here instead.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Shift an instant into "IST wall-clock" encoded as UTC fields.
const istShifted = (t) => new Date(t + IST_OFFSET_MS);

// UTC instant at which the IST day containing `t` begins. `dayOffset` moves
// forward/backward by whole IST days (e.g. -1 = yesterday's IST midnight).
function startOfIstDay(t = Date.now(), dayOffset = 0) {
  const s = istShifted(t);
  const midnightUtc = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS;
  return new Date(midnightUtc + dayOffset * DAY_MS);
}

// Last millisecond of the IST day containing `t` (optionally offset).
function endOfIstDay(t = Date.now(), dayOffset = 0) {
  return new Date(startOfIstDay(t, dayOffset + 1).getTime() - 1);
}

// UTC instant at which the IST month containing `t` begins. `monthOffset`
// shifts by whole months (e.g. -1 = first instant of last month). Date.UTC
// normalizes month overflow/underflow.
function startOfIstMonth(t = Date.now(), monthOffset = 0) {
  const s = istShifted(t);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + monthOffset, 1) - IST_OFFSET_MS);
}

// Last millisecond of the IST month containing `t` (optionally offset).
function endOfIstMonth(t = Date.now(), monthOffset = 0) {
  return new Date(startOfIstMonth(t, monthOffset + 1).getTime() - 1);
}

// YYYY-MM-DD key in IST — matches $dateToString with timezone "Asia/Kolkata".
function istDayKey(d = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(d));
}

// Parse a "YYYY-MM-DD" calendar date into the UTC instant at which that IST
// day begins. Returns null for anything that is not a plain calendar date.
//
// Why: `new Date("2026-01-15")` is parsed as UTC midnight, i.e. 05:30 IST on
// the 15th — so a "from 15 Jan" filter silently drops every transaction
// between 00:00 and 05:30 IST on the 15th.
function startOfIstDayFromDateString(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS);
}

// Last millisecond of the IST day named by a "YYYY-MM-DD" calendar date.
// Returns null for anything that is not a plain calendar date.
//
// Why: `new Date("2026-01-15")` as an $lte bound is midnight at the START of
// the 15th, so an inclusive "to 15 Jan" filter drops every transaction that
// happened later on the 15th.
function endOfIstDayFromDateString(value) {
  const start = startOfIstDayFromDateString(value);
  if (!start) return null;
  return new Date(start.getTime() + DAY_MS - 1);
}

// Mongo range object for a pair of YYYY-MM-DD bounds. Both ends are optional
// and inclusive, and both are pinned to IST day boundaries.
//
// Returns null when no usable bound was supplied, so callers can simply do
// `const range = istDateRange(startDate, endDate); if (range) query.createdAt = range;`
function istDateRange(startDate, endDate) {
  const range = {};

  if (startDate) {
    const s = startOfIstDayFromDateString(startDate);
    if (s) range.$gte = s;
  }
  if (endDate) {
    const e = endOfIstDayFromDateString(endDate);
    if (e) range.$lte = e;
  }

  return Object.keys(range).length ? range : null;
}

const pad2 = (n) => String(n).padStart(2, '0');

// e.g. "18 Oct" label in IST.
function istDayLabel(d = Date.now()) {
  const s = istShifted(new Date(d).getTime());
  return `${s.getUTCDate()} ${MONTHS[s.getUTCMonth()]}`;
}

module.exports = {
  IST_OFFSET_MS,
  DAY_MS,
  startOfIstDay,
  endOfIstDay,
  startOfIstMonth,
  endOfIstMonth,
  istDayKey,
  istDayLabel,
  startOfIstDayFromDateString,
  endOfIstDayFromDateString,
  istDateRange,
};
