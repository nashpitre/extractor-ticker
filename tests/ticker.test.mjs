import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('ticker caps topics at five and hides duplicate animation copies from accessibility',async()=>{
 const nodes=[];
 const make=()=>({children:[],attributes:{},classList:{add(){},toggle(){}},style:{setProperty(){}},addEventListener(){},appendChild(n){if(n.fragment)this.children.push(...n.children);else this.children.push(n)},setAttribute(k,v){this.attributes[k]=v}});
 const ticker=make();ticker.replaceChildren=()=>{ticker.children=[]};ticker.parentElement=make();
 const document={getElementById(id){return id==='home-connection-ticker-track'?ticker:null},createElement(){const n=make();nodes.push(n);return n},createDocumentFragment(){return Object.assign(make(),{fragment:true})}};
 const payload={connections:Array.from({length:8},(_,i)=>({label:'Topic '+i}))};
 const window={NASHP_EXTRACTOR_ENDPOINT:'/fixture',location:{},setTimeout(){}};
 vm.runInNewContext(fs.readFileSync('src/ticker.js','utf8'),{document,window,fetch:async()=>({ok:true,json:async()=>payload}),Set,Date,Math});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(ticker.children.length,10);
 assert.equal(ticker.children.filter(n=>n.attributes['aria-hidden']==='true').length,5);
 assert.deepEqual(ticker.children.slice(0,5).map(n=>n.textContent),payload.connections.slice(0,5).map(n=>n.label));
});
test('backend secrets are environment configuration, not committed credentials',()=>{
 const source=fs.readFileSync('worker/worker.js','utf8');
 assert(source.includes('env.REEDER_FEED_URL'));
 assert(!/https:\/\/reederapp\.net\//.test(source));
 assert(!/whsec_[a-zA-Z0-9]+|sk_live_[a-zA-Z0-9]+|ghp_[a-zA-Z0-9]+/.test(source));
 assert(!fs.existsSync('worker/.dev.vars'));
});
