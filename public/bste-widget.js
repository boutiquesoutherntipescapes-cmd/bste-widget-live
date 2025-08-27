(function(){
  const WIDGET_CSS = `
    .bste-card{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;
      border:1px solid rgba(0,0,0,0.12); padding:18px; border-radius:20px; box-shadow:0 10px 30px rgba(0,0,0,.05)}
    .bste-row{display:grid; grid-template-columns: 1fr 1fr 1fr auto; gap:18px; align-items:end}
    .bste-field{display:flex; flex-direction:column; gap:6px; min-width:160px}
    .bste-field label{font-size:12px; opacity:0.7}
    .bste-input{padding:10px 12px; border:1px solid rgba(0,0,0,0.15); border-radius:12px; background:#f8f8f8}
    .bste-btn{padding:10px 16px; border-radius:12px; border:1px solid #e0b98f; cursor:pointer}
    .bste-primary{background:rgb(245,194,148); color:#0f172a}
    .bste-note{font-size:12px; opacity:0.8; margin-top:8px}
    .bste-price{font-size:18px; font-weight:700; margin-top:10px}
    .bste-err{color:#b91c1c; font-size:12px; margin-top:6px}
    .bste-ok{color:#065f46; font-size:12px; margin-top:6px; font-weight:600}
    .bste-suggest{margin-top:10px;}
    .bste-s-title{font-size:12px; color:#374151; margin:6px 0;}
    .bste-s-pills{display:flex; flex-wrap:wrap; gap:8px;}
    .bste-pill{display:inline-block; padding:8px 12px; border:1px solid #d4d4d4; border-radius:9999px; background:#fff; cursor:pointer; font-size:13px;}
    .bste-altprops{margin-top:8px; display:grid; gap:8px;}
    .bste-prop{display:flex; align-items:center; justify-content:space-between; border:1px solid #e5e7eb; border-radius:12px; padding:10px 12px; background:#fff;}
    .bste-prop-name{font-weight:600;}
    .bste-prop-actions{display:flex; gap:8px;}
    .bste-link{padding:8px 12px; border:1px solid #e0b98f; border-radius:9999px; background:#fff; cursor:pointer; font-size:13px; text-decoration:none; color:#111827;}
    @media (max-width: 900px){ .bste-row{ grid-template-columns: 1fr 1fr } }
    @media (max-width: 560px){ .bste-row{ grid-template-columns: 1fr } }
  `;

  function el(tag, cls, html) { const e=document.createElement(tag); if(cls) e.className=cls; if(html) e.innerHTML=html; return e; }
  function $qs(sel, root=document){ return root.querySelector(sel); }
  function getParam(k){ return new URLSearchParams(location.search).get(k) || ""; }

  function findMounts(){ return Array.from(document.querySelectorAll('[data-bste-widget]')); }

  function render(mount){
    const property = mount.getAttribute('data-property');
    const apiBase = mount.getAttribute('data-api') || '';
    const bookingUrlBase = mount.getAttribute('data-booking-url') || '/booking';

    const style = document.createElement('style'); style.innerHTML = WIDGET_CSS;
    mount.appendChild(style);

    const card = el('div','bste-card');
    const row = el('div','bste-row');

    const f1 = el('div','bste-field');
    f1.appendChild(el('label','','Check in')); const inpIn = el('input','bste-input'); inpIn.type='date'; f1.appendChild(inpIn);

    const f2 = el('div','bste-field');
    f2.appendChild(el('label','','Check out')); const inpOut = el('input','bste-input'); inpOut.type='date'; f2.appendChild(inpOut);

    const f3 = el('div','bste-field');
    f3.appendChild(el('label','','Guests')); const inpG = el('input','bste-input'); inpG.type='number'; inpG.min='1'; inpG.value='2'; f3.appendChild(inpG);

    const actions = el('div','bste-field');
    const btn = el('button','bste-btn bste-primary','Check availability');
    actions.appendChild(btn);

    row.appendChild(f1); row.appendChild(f2); row.appendChild(f3); row.appendChild(actions);
    card.appendChild(row);

    const status = el('div','bste-note','');
    const price = el('div','bste-price','');
    const err = el('div','bste-err','');

    const suggWrap = el('div','bste-suggest','');            // nearby dates
    const altPropsWrap = el('div','bste-altprops','');       // other properties

    card.appendChild(status); card.appendChild(price); card.appendChild(err);
    card.appendChild(suggWrap); card.appendChild(altPropsWrap);

    const bookWrap = el('div','bste-row'); const bookBtn = el('button','bste-btn','Book now'); bookBtn.style.display='none';
    bookWrap.appendChild(bookBtn); card.appendChild(bookWrap);
    mount.appendChild(card);

    function clearUI(){
      err.textContent=''; price.textContent=''; status.textContent='';
      suggWrap.innerHTML=''; altPropsWrap.innerHTML='';
      bookBtn.style.display='none';
    }

    function renderSuggestions(list){
      if (!list || !list.length) return;
      const title = el('div','bste-s-title','Also available nearby:');
      const pills = el('div','bste-s-pills','');
      list.forEach(s=>{
        const label = `${s.check_in} → ${s.check_out} • ${new Intl.NumberFormat('en-ZA',{style:'currency',currency:s.currency||'ZAR'}).format(s.total_price_zar)}`;
        const pill = el('button','bste-pill', label);
        pill.addEventListener('click', ()=>{ inpIn.value=s.check_in; inpOut.value=s.check_out; check(); });
        pills.appendChild(pill);
      });
      suggWrap.appendChild(title); suggWrap.appendChild(pills);
    }

    function addParams(url, params){
      const hasQ = url.includes('?');
      const q = new URLSearchParams(params).toString();
      return url + (hasQ ? '&' : '?') + q;
    }

    function renderOtherProps(list){
      if (!list || !list.length) return;
      const title = el('div','bste-s-title','Other properties available for your dates:');
      altPropsWrap.appendChild(title);
      list.forEach(p=>{
        const row = el('div','bste-prop');
        row.appendChild(el('div','bste-prop-name', p.display_name));
        row.appendChild(el('div','', new Intl.NumberFormat('en-ZA',{style:'currency',currency:p.currency||'ZAR'}).format(p.total_price_zar)));
        const actions = el('div','bste-prop-actions');
        const view = el('a','bste-link','View property');
        view.target = '_self';
        // pass through the same dates & guests so that page pre-fills its widget
        view.href = addParams(p.property_page_url || '#', {
          check_in: inpIn.value, check_out: inpOut.value, guests: inpG.value
        });
        actions.appendChild(view);
        row.appendChild(actions);
        altPropsWrap.appendChild(row);
      });
    }

    async function check(){
      clearUI();
      const ci = inpIn.value; const co = inpOut.value;
      if (!ci || !co){ err.textContent='Select check-in and check-out.'; return; }
      try{
        const a = await fetch(`${apiBase}/api/availability?property_slug=${encodeURIComponent(property)}&check_in=${ci}&check_out=${co}`);
        const avail = await a.json();
        if (!a.ok) throw new Error(avail.error || 'Availability error');

        if (!avail.available){
          status.innerHTML = '<span class="bste-err">Not available for those dates.</span>';
          // Ask server for BOTH nearby dates and other properties
          const sres = await fetch(`${apiBase}/api/suggest`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ property_slug: property, check_in: ci, check_out: co })
          });
          const sjson = await sres.json();
          if (sres.ok){
            renderSuggestions(sjson.dates || []);
            renderOtherProps(sjson.other_properties || []);
          }
          return;
        }

        status.innerHTML = '<span class="bste-ok">Good news — available.</span>';

        const qres = await fetch(`${apiBase}/api/quote`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({property_slug: property, check_in: ci, check_out: co})
        });
        const quote = await qres.json();
        if (!qres.ok) throw new Error(quote.error || 'Quote error');

        if (!quote.min_stay_ok){
          status.innerHTML += ` <span class="bste-err">Min stay is ${quote.min_stay_required} nights.</span>`;
          return;
        }
        const fmt = new Intl.NumberFormat('en-ZA', {style:'currency', currency: quote.currency || 'ZAR'});
        price.textContent = `Total: ${fmt.format(quote.total_price_zar)} (${quote.nights} nights, incl. cleaning)`;

        bookBtn.style.display='inline-block';
        bookBtn.onclick = () => {
          const url = bookingUrlBase + `?property=${encodeURIComponent(property)}&check_in=${ci}&check_out=${co}&guests=${encodeURIComponent(inpG.value)}&total=${quote.total_price_zar}`;
          window.location.href = url;
        };
      }catch(e){ err.textContent = e.message; }
    }

    // Prefill from URL (so other property links can pre-populate dates)
    const urlIn  = getParam('check_in');  if (urlIn)  inpIn.value = urlIn;
    const urlOut = getParam('check_out'); if (urlOut) inpOut.value = urlOut;
    const urlG   = getParam('guests');    if (urlG)   inpG.value = urlG;

    const styleTag = document.createElement('style'); styleTag.innerHTML = WIDGET_CSS;
    btn.addEventListener('click', check);

    // Auto-run if both dates present in URL (nice for cross-property flow)
    if (inpIn.value && inpOut.value) { setTimeout(check, 0); }

    mount.appendChild(card);
  }

  function init(){ findMounts().forEach(render); }
  if (document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
