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
};
