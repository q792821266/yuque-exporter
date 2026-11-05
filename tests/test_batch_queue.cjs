// Exercise the production runner with synthetic responses and injected storage.
// No real account, network, browser profile or private document is accessed.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const records=new Map();
const doc=id=>({id,book_id:10,slug:'d'+id,title:'Doc '+id,type:'Doc',status:1,format:'lake',content_modified:false,published_at:'2026-10-27T00:00:00Z',content_updated_at:'2026-10-27T00:00:00Z',content:'<p>published</p>'});
const initial=()=>({owner_id:'9',owner_login:'me',run_id:'test',inventory_complete:true,books:[{id:'10',namespace:'me/book',name:'Notes',items_count:2,docs:[doc(1),doc(2)],toc:[]}],jobs:{'10/1':{book_id:'10',status:'pending'},'10/2':{book_id:'10',status:'pending'}}});
function runner(options={}) {
  const elements=new Map();
  const element=()=>({textContent:'',disabled:false,addEventListener(){},replaceChildren(){},append(){}});
  const context=vm.createContext({URL,TextEncoder,crypto:webcrypto,AbortSignal,setTimeout,clearTimeout,console,
    document:{getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element},
    // Initial UI read remains pending; persistence functions are injected below.
    indexedDB:{open:()=>({})},navigator:{locks:{request:async(_name,_opts,fn)=>fn({})}},
    state:structuredClone(records.get('state')),calls:[],options,
    persist:async(state,key,snapshot)=>{
      if(options.persist)await options.persist(state,key,snapshot);
      if(options.diskFull)throw new Error('storage quota exceeded');
      records.set('state',structuredClone(state));if(key)records.set(key,structuredClone(snapshot));
    },load:async key=>structuredClone(records.get(key)),
    response:async path=>{
      if(path==='/api/mine')return {id:9,login:options.otherOwner?'other':'me'};
      if(path==='/api/mine/book_stacks')return [{books:[{id:10,slug:'book',name:'Notes',items_count:2,user_id:9}]}];
      const id=Number(path.match(/\/api\/docs\/d(\d+)/)?.[1]);
      if(!id)throw new Error('Unexpected route');
      context.calls.push(id);
      if(options.failSecond && id===2)throw new Error('HTTP 503');
      return {...doc(id),...(options.draftSecond&&id===2?{status:0,content_modified:true}: {})};
    },
    fetch:async url=>{assert.equal(url,'verified-versions.json');return {ok:true,json:async()=>[]};},
  });
  for(const f of ['collector-core.js','concurrency.js','batch-model.js','batch.js'])vm.runInContext(fs.readFileSync('browser-collector/'+f,'utf8'),context);
  vm.runInContext('get=response;readRecord=load;commit=async(s,k,v)=>{await persist(s,k,v);if(options.pauseAfterCommit&&k)paused=true;};resourceURLs=()=>[];',context);
  if(options.capture)context.captureOne=options.capture;
  return {context,run:(retry,limit=5,concurrency=1)=>vm.runInContext(`run(state,${Boolean(retry)},${limit},${concurrency})`,context)};
}
(async()=>{
  records.set('state',initial());
  let bounded=runner();await bounded.run(false,1);
  assert.deepEqual(Array.from(bounded.context.calls),[1,1]);
  assert.equal(records.get('state').jobs['10/2'].status,'pending');
  bounded=runner();await bounded.run(true);
  assert.equal(bounded.context.calls.length,0); // Retry must not start pending work.
  bounded=runner();await assert.rejects(bounded.run(false,0),/每轮/);
  records.clear();
  records.set('state',initial());
  let r=runner({failSecond:true});await r.run(false);
  assert.equal(records.get('state').jobs['10/1'].status,'done');
  assert.equal(records.get('state').jobs['10/2'].status,'failed');
  assert.ok(records.get('10/1'));assert.equal(records.has('10/2'),false);
  r=runner();await r.run(false);assert.equal(r.context.calls.length,0);
  r=runner();await r.run(true);assert.deepEqual(Array.from(r.context.calls),[2,2]);
  assert.equal(records.get('state').jobs['10/2'].status,'done');
  records.clear();records.set('state',initial());
  r=runner({pauseAfterCommit:true});await r.run(false);
  assert.equal(records.get('state').jobs['10/2'].status,'pending');
  r=runner();await r.run(false);assert.deepEqual(Array.from(r.context.calls),[2,2]);
  records.clear();records.set('state',initial());
  r=runner({diskFull:true});await assert.rejects(r.run(false),/quota/);
  assert.equal(records.get('state').jobs['10/1'].status,'pending');assert.equal(records.has('10/1'),false);
  r=runner({otherOwner:true});await assert.rejects(r.run(false),/账号/);assert.equal(r.context.calls.length,0);
  r=runner({draftSecond:true});await r.run(false);
  assert.equal(records.get('state').jobs['10/2'].status,'failed');assert.equal(records.has('10/2'),false);
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const many=()=>{
    const state=initial();state.books[0].docs=Array.from({length:8},(_,i)=>doc(i+1));
    state.jobs=Object.fromEntries(state.books[0].docs.map(d=>['10/'+d.id,{book_id:'10',status:'pending'}]));
    return state;
  };
  records.clear();records.set('state',many());
  let active=0,peak=0,writes=0,peakWrites=0,started=[];
  r=runner({capture:async(_s,_b,d)=>{
    started.push(d.id);peak=Math.max(peak,++active);
    await delay(d.id===1?25:5);active--;return {document:d};
  },persist:async()=>{peakWrites=Math.max(peakWrites,++writes);await delay(2);writes--;}});
  await r.run(false,null,3);
  assert.equal(peak,3);assert.equal(peakWrites,1);assert.equal(active,0);
  assert.equal(started.length,8); // All means more than the old five-article default.
  assert.equal(Object.values(records.get('state').jobs).filter(j=>j.status==='done').length,8);
  for(let id=1;id<=8;id++)assert.equal(records.get('10/'+id).document.id,id);
  records.clear();records.set('state',many());started=[];
  r=runner({pauseAfterCommit:true,capture:async(_s,_b,d)=>{
    started.push(d.id);await delay(d.id===1?1:15);return {document:d};
  }});
  await r.run(false,null,3);
  assert.deepEqual(started,[1,2,3]);
  assert.equal(Object.values(records.get('state').jobs).filter(j=>j.status==='done').length,3);
  assert.equal(records.get('state').jobs['10/4'].status,'pending');
  records.clear();records.set('state',many());started=[];active=0;
  r=runner({diskFull:true,capture:async(_s,_b,d)=>{
    started.push(d.id);active++;await delay(d.id===1?1:15);active--;return {document:d};
  }});
  await assert.rejects(r.run(false,null,3),/quota/);
  assert.equal(active,0);assert.deepEqual(started,[1,2,3]);
  assert.equal(records.size,1);assert.ok(Object.values(records.get('state').jobs).every(j=>j.status==='pending'));
  assert.ok(Object.values(r.context.state.jobs).every(j=>j.status==='pending'));
  await assert.rejects(r.run(false,null,5),/同时/);
  records.clear();records.set('state',initial());
  r=runner();await r.run(false);
  const old=records.get('state'), original=structuredClone(records.get('10/2'));
  const refresh=runner(), ctx=refresh.context;
  const newDocs=[doc(1),{...doc(2),title:'Revised'},doc(3)];
  ctx.get=async path=>{
    if(path==='/api/mine')return {id:9,login:'me'};
    if(path==='/api/mine/book_stacks')return [{books:[{id:10,slug:'book',name:'Notes',items_count:3,user_id:9}]}];
    if(path.startsWith('/api/docs?'))return newDocs;
    const id=Number(path.match(/docs\/d(\d+)/)[1]);
    return newDocs.find(d=>d.id===id);
  };
  ctx.fetch=async()=>({ok:false,status:503});
  await assert.rejects(ctx.inventory(null,old,true),/503/);
  assert.equal(records.get('state').run_id,old.run_id);
  ctx.fetch=async()=>({ok:true,text:async()=>'decodeURIComponent("'+encodeURIComponent(JSON.stringify({book:{id:10,toc:[]}}))+'")'});
  await ctx.inventory(null,old,true);
  const next=records.get('state');
  assert.deepEqual(Object.values(next.jobs).map(j=>j.status),['done','pending','pending']);
  assert.deepEqual(records.get('history/'+old.run_id),old);
  await ctx.run(next,false);
  assert.deepEqual(records.get('10/2'),original);
  const complete=records.get('state');
  assert.equal(records.get(complete.jobs['10/2'].snapshot_key).document.title,'Revised');
  ctx.packed={};
  vm.runInContext('class SnapshotZip {async addJSON(name,data){packed[name]=data;} finish(){return {};}};downloadBlob=async()=>{};',ctx);
  await ctx.save(complete);
  assert.equal(ctx.packed['doc-10-1.json'].run_id,next.run_id);
  assert.equal(ctx.packed['doc-10-2.json'].document.title,'Revised');
  assert.equal(ctx.packed['inventory.json'].jobs['10/1'].snapshot_key,undefined);
  await ctx.save(old);
  assert.equal(ctx.packed['doc-10-2.json'].document.title,original.document.title);
  await ctx.inventory(null,complete,false);
  assert.ok(Object.values(records.get('state').jobs).every(job=>job.status==='pending'));
  console.log('Legacy task upgrade, failed refresh, incremental reuse, independent history exports and full rescan passed.');
  console.log('Production queue resume, skip-success, retry, pause, quota and version rejection checks passed (injected storage).');
  console.log('Concurrent captures, serialized atomic saves, all selection, in-flight pause and storage-failure drain passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
