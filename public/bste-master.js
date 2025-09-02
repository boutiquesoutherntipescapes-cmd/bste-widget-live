// /public/bste-master.js — Master search widget for the Home page
(function(){
  const CSS = `
    .bste-m-card{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;
      border:1px solid rgba(0,0,0,0.12); padding:18px; border-radius:20px; box-shadow:0 10px 30px rgba(0,0,0,.05)}
    .bste-m-row{display:grid; grid-template-columns: 1fr 1fr 1fr auto; gap:18px; align-items:end}
    .bste-m-field{display:flex; flex-direction:column; gap:6px; min-width:160px}
    .bste-m-field label{font-size:12px; opacity:0.7}
    .bste-m-input{padding:10px 12px; border:1px solid rgba(0,0,0,0.15); border-radius:12px; background:#f8f8f8}
    .bste-m-btn{padding:10px 16px; border-radius:12px; border:1px solid #e0b98f; cursor:pointer}
    .bste-m-primary{background:rgb(245,194,148); color:#0f172a}
    .bste-m-note{font-size:12px; opacity:0.85; margin-top:10px}
    .bste-m-err{font-size:12px; color:#b91c1c; margin-top:8px}
    .bste-m-grid{margin-top:14px; display:grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap:14px}
    .bste-m-item{border:1px solid #e5e7eb; border-radius:16px; padding:14px; background:#fff; display:flex; flex-direction:column; gap:8px}
    .bste-m-title{font-weight:700}
    .bste-m-price{font-weight:700; font-size:16px}
    .bste-m-actions{margin-top:auto; display:flex; gap:8px; flex-wrap:wrap}
    .bste-m-link{padding:8px 12px; border:1px solid #e0b98f; border-radius:9999px; background:#fff; cursor:pointer; font-size:13px; text-decoration:none; color:#111827;}
    .bste-m-empty{font-size:14px; color:#374151; border:1px dashed #e5e7eb; border-radius:12px; padding:14px; text-align:center; background:#fff}
    .bste-m-loading{font-size:13px; color:#374151}
    @media (max-width: 1100px){ .bste-m-grid{ grid-template-columns: repeat(2,minmax(0,1fr)) } }
    @media (max-width: 700px){ .bste-m-row{ grid-template-columns: 1fr 1fr } .bste-m-grid{ grid-template-columns: 1fr } }
  `;
  (function(){ const s=document.createElement('style'); s.innerHTML=CSS; document.head.appendChild(s); })();

  function el(tag, cls, html){ const e=document.createElement(tag); if(cls) e.className=cls; if(html) e.innerHTML=html; return e; }
  function getParam(k){ return new URLSearchParams(location.search).get(k) || ""; }
  function addParams(url, params){ const q=new URLSearchParams(params).toString(); return url + (url.includes('?')?'&':'?') + q; }
  function findMounts(){ return Array.from(document.querySelectorAll('[data-bste-master]')); }

  function render(mount){
    const apiBase = mount.getAttribute('data-api') || '';
    const intro   = mount.getAttribute('data-intro') || '';

    const card = el('div','bste-m-card');
    if (intro) card.appendChild(el('div','bste-m-note', intro));

    const row = el('div','bste-m-row');
    const f1 = el('div','bste-m-field'); f1.appendChild(el('label','','Check in'));  const inpIn = el('input','bste-m-input'); inpIn.type='date'; f1.appendChild(inpIn);
    const f2 = el('div','bste-m-field'); f2.appendChild(el('label','','Check out')); const inpOut= el('input','bste-m-input'); inpOut.type='date'; f2.appendChild(inpOut);
    const f3 = el('div','bste-m-field'); f3.appendChild(el('label','','Guests'));   const inpG  = el('input','bste-m-input'); inpG.type='number'; inpG.min='1'; inpG.value='2'; f3.appendChild(inpG);
    const actions = el('div','bste-m-field'); const btn = el('button','bste-m-btn bste-m-primary','Search'); actions.appendChild(btn);
    row.appendChild(f1); row.appendChild(f2); row.appendChild(f3); row.appendChild(actions);
    card.appendChild(row);

    const err = el('div','bste-m-err',''); card.appendChild(err);
    const note = el('div','bste-m-note',''); card.appendChild(note);
    const grid = el('div','bste-m-grid',''); card.appendChild(grid);
    mount.appendChild(card);

    const fmtCurrency = (v, c='ZAR') => new Intl.NumberFormat('en-ZA',{style:'currency',currency:c}).format(Number(v||0));

    function clear(){ err.textContent=''; note.textContent=''; grid.innerHTML=''; }

    async function search(){
      clear();
      const ci=inpIn.value, co=inpOut.value, g=inpG.value || '2';
      if (!ci || !co) { err.textContent='Please select check-in and check-out dates.'; return; }
      note.innerHTML = '<span class="bste-m-loading">Checking all properties…</span>';

      try {
        const qs = new URLSearchParams({ check_in:ci, check_out:co, guests:g }).toString();
        const res = await fetch(`${apiBase}/api/search?${qs}`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Search error');

        const list = json.results || [];
        note.textContent = `${list.length} ${list.length===1?'property':'properties'} available for your dates.`;

        if (!list.length) {
          grid.appendChild(el('div','bste-m-empty','No properties match those dates. Try shifting a day or two.'));
          return;
        }

        for (const p of list) {
          const item = el('div','bste-m-item');
          item.appendChild(el('div','bste-m-title', p.display_name));
          item.appendChild(el('div','', `${json.check_in} → ${json.check_out} • ${p.nights} nights`));
          item.appendChild(el('div','bste-m-price', fmtCurrency(p.total_price_zar, p.currency)));

          const actions = el('div','bste-m-actions');
          const view = el('a','bste-m-link','View property');
          view.href = addParams(p.property_page_url || '#', { check_in: json.check_in, check_out: json.check_out, guests: json.guests });
          view.target = '_self';
          actions.appendChild(view);

          item.appendChild(actions);
          grid.appendChild(item);
        }
      } catch (e) {
        err.textContent = e.message;
      }
    }

    // Prefill from URL if present
    const urlIn  = getParam('check_in');  if (urlIn)  inpIn.value = urlIn;
    const urlOut = getParam('check_out'); if (urlOut) inpOut.value = urlOut;
    const urlG   = getParam('guests');    if (urlG)   inpG.value = urlG;

    btn.addEventListener('click', search);
    if (inpIn.value && inpOut.value) { setTimeout(search, 0); }
  }

  function init(){ findMounts().forEach(render); }
  if (document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
