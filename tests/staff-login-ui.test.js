import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function ui(replies) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, value: '', disabled: true, textContent: '', handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      querySelector() { return element(id + '-button'); },
      replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; },
      removeAttribute(name) { delete this[name]; } });
    return elements.get(id);
  };
  const calls = [];
  const window = element('window');
  const context = vm.createContext({ document: { getElementById: element }, window,
    Option: function(text,value) { this.text=text; this.value=value; },
    setTimeout: () => 1, clearTimeout: () => {}, encodeURIComponent,
    fetch: async (url, opts) => {
      calls.push({url,opts});
      if (!opts) return { ok: false }; // Initial anonymous GET.
      const reply = replies.shift(); assert.ok(reply, 'Unexpected UI request');
      return { ok: reply.ok !== false, json: async () => reply.data };
    }
  });
  vm.runInContext(fs.readFileSync(new URL('../public/staff-login.js', import.meta.url), 'utf8'), context);
  return { element, calls, event: async (id,name) => element(id).handlers[name]({preventDefault(){}}) };
}
test('first login shows setup, renders QR as an image, then clears seed on verification', async () => {
  const app = ui([{data:{mfa_required:true,factors:[]}},
    {data:{enrollment:{factor_id:'f',qr_code:'<svg/>',secret:'TEST-SEED'}}},
    {data:{staff:{display_name:'Bond'}}}]);
  await app.event('login','submit'); assert.equal(app.element('enrollment').hidden,false);
  await app.event('start-enrollment','click');
  assert.match(app.element('setup-qr').src,/^data:image\/svg\+xml/);
  assert.equal(app.element('setup-secret').textContent,'TEST-SEED');
  app.element('code').value='123456'; await app.event('mfa','submit');
  assert.equal(app.element('setup-secret').textContent,''); assert.equal(app.element('setup-qr').src,undefined);
  assert.equal(app.element('enrollment').hidden,true); assert.match(app.element('status').textContent,/Signed in as Bond/);
});
test('existing MFA users see challenge instead of setup', async () => {
  const app=ui([{data:{mfa_required:true,factors:[{id:'existing'}]}}]);
  await app.event('login','submit');
  assert.equal(app.element('enrollment').hidden,true); assert.equal(app.element('mfa').hidden,false);
  assert.equal(app.element('factor').value,'existing'); assert.equal(app.calls.length,2);
});
test('failed code retains setup for retry but clears entered code', async () => {
  const app=ui([{data:{mfa_required:true,factors:[]}},
    {data:{enrollment:{factor_id:'f',qr_code:'<svg/>',secret:'TEST-SEED'}}},
    {ok:false,data:{error:'Code rejected'}}]);
  await app.event('login','submit'); await app.event('start-enrollment','click');
  app.element('code').value='999999'; await app.event('mfa','submit');
  assert.equal(app.element('code').value,''); assert.equal(app.element('setup-secret').textContent,'TEST-SEED');
  assert.equal(app.element('status').textContent,'Code rejected');
});
test('logout and page exit clear authenticator setup details', async () => {
  const app=ui([{data:{mfa_required:true,factors:[]}},
    {data:{enrollment:{factor_id:'f',qr_code:'<svg/>',secret:'TEST-SEED'}}},{data:{signed_out:true}}]);
  await app.event('login','submit'); await app.event('start-enrollment','click'); await app.event('logout','click');
  assert.equal(app.element('setup-secret').textContent,''); assert.equal(app.element('setup-qr').src,undefined);
  app.element('setup-secret').textContent='TEST-SEED'; await app.event('window','pagehide');
  assert.equal(app.element('setup-secret').textContent,'');
});
