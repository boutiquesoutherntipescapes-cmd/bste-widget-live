import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import * as model from '../lib/stay-readiness.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function element(tag='div'){return {tagName:tag.toUpperCase(),children:[],handlers:{},value:'',textContent:'',hidden:false,disabled:false,append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(){},addEventListener(k,fn){this.handlers[k]=fn;},querySelectorAll(tag){return flatten(this).filter(n=>n.tagName===tag.toUpperCase());}};}
function flatten(n){return [n,...n.children.flatMap(flatten)];}
const b={id:'10000000-0000-4000-8000-000000000001',property_slug:'legacy-suiderstrand',guest_name:'<img onerror=bad()>',arrival:'2030-10-04',departure:'2030-10-08',source_status:'new',source_channel:'airbnb',source_kind:'beds24'};
const c={id:'20000000-0000-4000-8000-000000000001',revision:1,checkpoint_key:'pre_arrival',label:'Pre-arrival readiness',due_at:'2030-10-01T08:00:00+02:00',status:'pending',items:[{label:'Pre-clean completed',status:'pending'}]};
const row=()=>({booking:b,checkpoints:[c],cleaning:null,history:[],communications:[]});
function setup(replies){const elements=new Map(),calls=[];const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};get('readiness-window').value='today';
 class Clock extends Date{constructor(...args){super(...(args.length?args:['2030-10-01T08:00:00Z']));}static now(){return Date.parse('2030-10-01T08:00:00Z');}}
 const context=vm.createContext({...model,Date:Clock,document:{getElementById:get,createElement:element,querySelector:()=>null,activeElement:null},setInterval(){},currentOperationsStaff:[{permissions:['operations.read','operations.write']},[{slug:'legacy-suiderstrand',name:'Legacy'}]],fetch:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});const response=replies.shift();assert.ok(response,'Unexpected request');return {ok:response.ok!==false,json:async()=>response.body};}});
 const source=fs.readFileSync(new URL('../public/staff-readiness.js',import.meta.url),'utf8').replace(/^import .*;\n/,'');vm.runInContext(source,context);return {get,calls};}
function byText(app,text){return flatten(app.get('readiness-stays')).find(n=>n.textContent===text);}
test('today includes a future arrival whose preparation checkpoint is due; guest is text only',async()=>{const app=setup([{body:[row()]}]);await tick();assert.equal(app.get('readiness-stays').children.length,1);assert.ok(byText(app,'Legacy · <img onerror=bad()>'));assert.ok(byText(app,'Preview internal prompt'));assert.equal(app.calls.length,1);assert.equal(app.calls[0].body.action,'read');});
test('preview is explicit; simulation saves once, reloads saved state and reports success',async()=>{const actions={yes:'A'.repeat(43),no:'B'.repeat(43),tomorrow:'C'.repeat(43)};
 const app=setup([{body:[row()]},{body:{checkpoint:c,booking:b,property_name:'Legacy',actions}},{body:{saved:true}},{body:[{...row(),checkpoints:[{...c,status:'complete'}]}]}]);await tick();await byText(app,'Preview internal prompt').handlers.click();assert.equal(app.calls.length,2);
 app.get('readiness-window').value='week';const btn=byText(app,'SIMULATE YES — READY');await btn.handlers.click();await btn.handlers.click();assert.equal(app.calls.length,4);assert.equal(app.calls[2].body.action,'respond');assert.equal(app.calls[3].body.action,'read');assert.equal(byText(app,'Preview internal prompt').disabled,false);assert.match(app.get('readiness-notice').textContent,/Response saved and audited/);assert.ok(app.calls.every(c=>c.url==='/api/staff-readiness'));});
test('uncertain failure keeps typed note and disables all replay buttons without silent retry',async()=>{const app=setup([{body:[row()]},{body:{checkpoint:c,booking:b,property_name:'Legacy',actions:{yes:'A'.repeat(43),no:'B'.repeat(43),tomorrow:'C'.repeat(43)}}},{ok:false,body:{error:'Storage unavailable'}}]);await tick();await byText(app,'Preview internal prompt').handlers.click();const textarea=flatten(app.get('readiness-stays')).find(n=>n.tagName==='TEXTAREA');textarea.value='Synthetic maintenance issue';const no=byText(app,'SIMULATE NO — NEEDS ATTENTION');await no.handlers.click();await no.handlers.click();assert.equal(app.calls.length,3);assert.equal(textarea.value,'Synthetic maintenance issue');assert.equal(no.disabled,true);assert.ok(flatten(app.get('readiness-stays')).some(n=>/Outcome may be uncertain/.test(n.textContent)));});
test('readiness load failure is visible and does not call generation or delivery',async()=>{const app=setup([{ok:false,body:{error:'Migration unavailable'}}]);await tick();assert.match(app.get('readiness-notice').textContent,/Readiness unavailable/);assert.equal(app.calls.length,1);});

test('repeated preview replaces the pane instead of adding another action set',async()=>{
 const reply={checkpoint:c,booking:b,property_name:'Legacy',actions:{yes:'A'.repeat(43),no:'B'.repeat(43),tomorrow:'C'.repeat(43)}};
 const app=setup([{body:[row()]},{body:reply},{body:reply}]);await tick();const preview=byText(app,'Preview internal prompt');await preview.handlers.click();await preview.handlers.click();
 assert.equal(flatten(app.get('readiness-stays')).filter(n=>n.className==='prompt-preview').length,1);assert.equal(flatten(app.get('readiness-stays')).filter(n=>n.textContent==='SIMULATE YES — READY').length,1);
});
test('lost capability cache requires explicit replacement click, never automatic retry',async()=>{
 const app=setup([{body:[row()]},{body:{checkpoint:c,booking:b,prompt_id:c.id,replacement_required:true,actions:null}},{body:{checkpoint:c,booking:b,prompt_id:c.id,replacement_required:true,actions:null}}]);await tick();await byText(app,'Preview internal prompt').handlers.click();assert.equal(app.calls.length,2);assert.equal(byText(app,'SIMULATE YES — READY'),undefined);await byText(app,'Replace unavailable preview actions').handlers.click();assert.equal(app.calls[2].body.replace_prompt_id,c.id);
});
test('consumed replay tells staff that current state was reloaded',async()=>{
 const app=setup([{body:[row()]},{body:{checkpoint:c,booking:b,actions:{yes:'A'.repeat(43),no:'B'.repeat(43),tomorrow:'C'.repeat(43)}}},{body:{saved:true,replayed:true}},{body:[{...row(),checkpoints:[{...c,status:'complete',schedule_review:true}]}]}]);await tick();await byText(app,'Preview internal prompt').handlers.click();await byText(app,'SIMULATE YES — READY').handlers.click();assert.match(app.get('readiness-notice').textContent,/Previously recorded response.*Current saved readiness reloaded/);assert.ok(byText(app,'ATTENTION / CHECKS PENDING'));
});
test('review-required and database-ineligible stays expose no preview actions',async()=>{
 const app=setup([{body:[{...row(),booking:{...b,source_status:'confirmed',operational_status:'review_required',readiness_eligible:false}}]}]);await tick();assert.equal(byText(app,'Preview internal prompt'),undefined);assert.equal(byText(app,'READY FOR ARRIVAL ✓'),undefined);
});
test('old deferred work stays visible before its deadline',async()=>{
 const app=setup([{body:[{...row(),booking:{...b,arrival:'2030-09-01',departure:'2030-09-05'},checkpoints:[{...c,status:'deferred',deferred_until:'2030-10-02T06:00:00Z'}]}]}]);await tick();assert.ok(byText(app,'Legacy · <img onerror=bad()>'));assert.ok(flatten(app.get('readiness-stays')).some(n=>n.textContent.includes('Deferred until')));
});
