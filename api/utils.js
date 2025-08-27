// ===== utils.js (drop-in) =====

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
  // normalise to midnight UTC for date-only math
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
// Accepts forms like: "Feb-Jun, Oct, Nov" or "2-6,10,11"
export function parseMonthsSpec(spec) {
  if (!spec) return [];
  const MONTHS = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
    jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
  };
  const add = new Set();
  const parts = String(spec).split(',').map(s => s.trim()).filter(Boolean);

  const toNum = (token) => {
    const t = token.toLowerCase();
    if (MONTHS[t]) return MONTHS[t];
    const n = parseInt(t, 10);
    if (n >= 1 && n <= 12) return n;
    throw new Error(`Invalid month token: ${token}`);
  };

  for (const p of parts) {
    if (p.includes('-')) {
      const [a,b] = p.split('-').map(s => s.trim());
      const start = toNum(a), end = toNum(b);
      if (start <= end) {
        for (let m = start; m <= end; m++) add.add(m);
      } else {
        // wrap-around range like "Nov-Feb"
        for (let m = start; m <= 12; m++) add.add(m);
        for (let m = 1; m <= end; m++) add.add(m);
      }
    } else {
      add.add(toNum(p));
    }
  }
  return Array.from(add).sort((x,y)=>x-y);
}
