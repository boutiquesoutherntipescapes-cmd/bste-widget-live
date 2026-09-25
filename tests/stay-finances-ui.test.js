import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function setup(){const elements=new Map(),calls=[];
 const element=()=>({children:[],handlers:{},hidden:false,value:'',append(...a){this.children.push(...a);},replaceChildren(...a){this.children=a;},addEventListener(k,v){this.handlers[k]=v;}});
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);};
 const context=vm.createContext({document:{getElementById:get,createElement:element},Date,Intl,crypto:{randomUUID:()=> 'id'},fetch:async(url,opts)=>{calls.push({url,opts});return{ok:true,json:async()=>({bookings:[],rates:[]})};}});
 vm.runInContext(fs.readFileSync(new URL('../public/staff-finances.js',import.meta.url),'utf8'),context);
 return{get,calls,context};
}
test('financial panel stays hidden for Operations and makes no automatic service calls',()=>{
 const a=setup();a.context.initStayFinances({permissions:['operations.read']});
 assert.equal(a.get('stay-finances').hidden,true);assert.equal(a.calls.length,0);
});
test('Finance sees the panel but must explicitly load a checkout month',async()=>{
 const a=setup();a.context.initStayFinances({permissions:['finance.read','finance.write']});
 assert.equal(a.get('stay-finances').hidden,false);assert.equal(a.calls.length,0);
 a.get('finance-load').handlers.click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.calls[0].url,'/api/staff-finances');assert.equal(JSON.parse(a.calls[0].opts.body).action,'list');
});
