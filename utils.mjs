export function parseMonthsSpec(spec) {
  const monthMap = {
    jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
    jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
  };
  const parts = (spec || '').split(',').map(s => s.trim()).filter(Boolean);
  const months = new Set();
  for (const part of parts) {
    const m = part.toLowerCase();
    if (m.includes('-')) {
      const [a,b] = m.split('-').map(x => x.trim());
      const start = monthMap[a.slice(0,3)] || monthMap[a];
      const end   = monthMap[b.slice(0,3)] || monthMap[b];
      if (!start || !end) continue;
      if (start <= end) {
        for (let k=start; k<=end; k++) months.add(k);
      } else {
        for (let k=start; k<=12; k++) months.add(k);
        for (let k=1; k<=end; k++) months.add(k);
      }
    } else {
      const mnum = monthMap[m.slice(0,3)] || monthMap[m];
      if (mnum) months.add(mnum);
    }
  }
  return Array.from(months.values()).sort((a,b)=>a-b);
}

export function stayNights(checkIn, checkOut) {
  const ms = new Date(checkOut) - new Date(checkIn);
  const nights = Math.round(ms/(1000*60*60*24));
  return nights < 0 ? 0 : nights;
}

export function dateRangeList(checkIn, nights) {
  const out = [];
  const start = new Date(checkIn);
  for (let i=0;i<nights;i++) {
    const d = new Date(start);
    d.setDate(d.getDate()+i);
    out.push(d);
  }
  return out;
}

export function isoDate(d) {
  const z = new Date(d);
  return z.toISOString().slice(0,10);
}

export function overlaps(aStart, aEnd, bStart, bEnd) {
  return (aStart < bEnd) && (bStart < aEnd);
}
