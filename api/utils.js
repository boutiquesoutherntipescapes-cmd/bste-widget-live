// ===== utils.js (robust months + date helpers + Easter weekend pricing helper) =====

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

  let s = String(spec).toLowerCase()
    .replace(/–|—/g, '-')
    .replace(/\bto\b/g, '-')
    .replace(/\bthrough\b/g, '-')
    .replace(/\+/g, ',')
    .replace(/&/g, ',')
    .replace(/\band\b/g, ',')
    .replace(/\./g, '');

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

// Add or subtract days from a YYYY-MM-DD date string
export function addDaysYmd(ymdString, days) {
  const d = new Date(ymdString + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

// Calculate Easter Sunday for a given year.
// This uses the standard Gregorian calendar calculation.
export function easterSundayYmd(year) {
  const y = Number(year);

  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);

  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;

  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Easter long-weekend nights:
// Thursday night before Good Friday, Good Friday night, Saturday night, Easter Sunday night.
// In date terms, that is Easter Sunday minus 3 days through Easter Sunday itself.
export function isEasterWeekendNight(dateLike) {
  const night = ymd(dateLike);
  const year = Number(night.slice(0, 4));
  const easterSunday = easterSundayYmd(year);

  const easterWeekendNights = new Set([
    addDaysYmd(easterSunday, -3),
    addDaysYmd(easterSunday, -2),
    addDaysYmd(easterSunday, -1),
    easterSunday
  ]);

  return easterWeekendNights.has(night);
}

// Choose the correct season for a specific night.
// Easter weekend overrides normal monthly pricing and uses Shoulder Season.
export function seasonForDate(dateLike, seasons) {
  const night = ymd(dateLike);

  if (isEasterWeekendNight(night)) {
    const shoulder = seasons.find(s => String(s.name || '').toLowerCase().includes('shoulder'));
    if (shoulder) {
      return {
        ...shoulder,
        easterOverride: true
      };
    }
  }

  const month = new Date(night + 'T00:00:00Z').getUTCMonth() + 1;
  return seasons.find(S => (S.months || []).includes(month)) || null;
}
