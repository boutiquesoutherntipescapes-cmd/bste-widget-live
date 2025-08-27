// ===== utils.js (robust months + date helpers) =====

// Return true if [aStart,aEnd) overlaps [bStart,bEnd)
export function overlaps(aStart, aEnd, bStart, bEnd) {
  const A = new Date(aStart), B = new Date(aEnd);
  const C = new Date(bStart), D = new Date(bEnd);
  return (A < D) && (C < B);
}

// YYYY-MM-DD from a Date or date-like
export function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// Nights count between two dates (check-out exclusive)
export function stayNights(check_in, check_out) {
  const a = new Date(check_in), b = new Date(check_out);
  a.setUTCHours(0,0,0,0); b.setUTCHours(0,0,0,0);
  const diff = Math.round((b - a) / 86400000);
  return Math.max(0, diff);
}

// List of night start dates (YYYY-MM-DD) for a stay
export function dateRangeList(check_in, nights) {
  const out = [];
  const d = new Date(check_in);
  d.setUTCHours(0,0,0,0);
  for (let i = 0; i < Number(nights || 0); i++) {
    out.push(new Date(d).toISOString().slice(0,10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Normalise to YYYY-MM-DD
export function ymd(d) {
  return new Date(d).toISOString().slice(0,10);
}

// Array of YYYY-MM-DD for each NIGHT in [start, end)
export function nightsBetween(start, end) {
  const out = [];
  const a = new Date(start), b = new Date(end);
  a.setUTCHours(0,0,0,0); b.setUTCHours(0,0,0,0);
  for (let t = a.getTime(); t < b.getTime(); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0,10));
  }
  return out;
}

// Parse season month spec into array of month numbers [1..12]
// Accepts:
//  - Full names: "February", "October", "December"
//  - Short names: "Feb", "Oct", "Dec"
//  - Ranges: "Feb-Jun", "November–February", "Mar to May", "Aug through Sep"
//  - Lists: "Feb, Jun, Oct", "December + January", "Oct & Nov", "Jun and Jul"
//  - Numbers: "2-6,10,11"
// Case-insensitive; tolerant of punctuation and mixed separators
export function parseMonthsSpec(spec) {
  if (!spec) return [];
  // normalise separators & punctuation
  let s = String(spec).toLowerCase()
    .replace(/–|—/g, '-')       // en/em dashes -> hyphen
    .replace(/\bto\b/g, '-')    // "to" -> hyphen
    .replace(/\bthrough\b/g, '-') // "through" -> hyphen
    .replace(/\+/g, ',')        // plus -> comma
    .replace(/&/g, ',')         // ampersand -> comma
    .replace(/\band\b/g, ',')   // "and" -> comma
    .replace(/\./g, '');        // remove trailing dots like "Sept."
  // map of month names (short + long) -> number
  const MONTHS = {
    jan:1, january:1,
    feb:2, february:2,
    mar:3, march:3,
    apr:4, april:4,
    may:5,
    jun:6, june:6,
    jul:7, july:7,
    aug:8, august:8,
    sep:9, sept:9, september:9,
    oct:10, october:10,
    nov:11, november:11,
    dec:12, december:12
  };

  const add = new Set();
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);

  const toNum = (token) => {
    const t = token.trim();
    if (!t) return null;
    if (MONTHS[t] != null) return MONTHS[t];
    // try first 3 letters if full name given weirdly
    const t3 = t.slice(0,3);
    if (MONTHS[t3] != null) return MONTHS[t3];
    const n = parseInt(t, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= 12) return n;
    throw new Error(`Invalid month token: ${token}`);
  };

  for (const p of parts) {
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-').map(x => x.trim()).filter(Boolean);
      if (!a && !b) continue;
      if (a && !b) { add.add(toNum(a)); continue; }
      if (!a && b) { add.add(toNum(b)); continue; }
      const start = toNum(a), end = toNum(b);
      if (start == null || end == null) continue;
      if (start <= end) {
        for (let m = start; m <= end; m++) add.add(m);
      } else {
        // wrap-around range like "Nov-Feb"
        for (let m = start; m <= 12; m++) add.add(m);
        for (let m = 1; m <= end; m++) add.add(m);
      }
    } else {
      const n = toNum(p);
      if (n != null) add.add(n);
    }
  }
  return Array.from(add).sort((x,y)=>x-y);
}
