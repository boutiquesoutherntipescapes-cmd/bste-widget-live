import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { presentDashboard } from '../lib/operations-model.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(replies){const elements=new Map();
 function element(tag){return {tag,children:[],hidden:false,value:'',disabled:false,textContent:'',handlers:{},append(...n){this.children.push(...n);},replaceChildren(...n){this.children=n;},setAttribute(k,v){this[k]=v;},addEventListener(k,fn){this.handlers[k]=fn;}};}
 const get=id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);};get('group').value='all';
 const calls=[];const context=vm.createContext({document:{getElementById:get,createElement:element},setInterval:()=>{},Date,
 location:{assign(){}},fetch:async(url,options)=>{calls.push({url,options});const next=replies.shift();assert.ok(next,'Unexpected request');return {ok:next.ok!==false,json:async()=>next.data};}});
 vm.runInContext(fs.readFileSync(new URL('../public/staff-dashboard.js',import.meta.url),'utf8'),context);
 return {get,calls};
}
function data(runs=[]){return {staff:{display_name:'Bond',role:'administrator',permissions:['operations.read','sync.run']},...presentDashboard([
 {id:'test',property_slug:'legacy-suiderstrand',arrival:'2030-01-10',departure:'2030-01-15',source_status:'request',guest_name:'<img onerror=alert(1)>',beds24_booking_id:1,payment_visible:true,payment_status:'deposit_paid',operational_status:'confirmed'}],runs,new Date('2030-01-11'))};}
test('dashboard renders three properties and distinct raw, operational and payment state as text',async()=>{
 const app=setup([{data:data()}]);await tick();
 assert.equal(app.get('properties').children.length,3);
 const row=app.get('bookings').children[0];assert.equal(row.children[0].textContent,'<img onerror=alert(1)>');
 assert.equal(row.children[5].textContent,'request');assert.equal(row.children[6].textContent,'confirmed');assert.equal(row.children[7].textContent,'deposit paid');
});
test('failed refresh retains saved rows with a visible failure/stale warning',async()=>{
 const app=setup([{data:data()},{ok:false,data:{error:'Refresh failed'}},{data:data([{status:'failed'}])}]);await tick();
 await app.get('refresh').handlers.click();
 assert.equal(app.get('bookings').children.length,1);assert.match(app.get('notice').textContent,/stale/);
});
test('unauthorized dashboard response hides data and directs staff to sign in',async()=>{
 const app=setup([{ok:false,data:{error:'Sign in required'}}]);await tick();
 assert.equal(app.get('dashboard').hidden,true);assert.match(app.get('notice').textContent,/Sign in/);
});
