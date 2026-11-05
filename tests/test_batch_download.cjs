const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const doc=id=>({id,book_id:10,slug:'doc'+id,title:'中文文章 '+id,type:'Doc',status:1,format:'lake',content_modified:false,
  published_at:'2026-10-27T00:00:00Z',content_updated_at:'2026-10-27T00:00:00Z',
  content:'<p>已发布正文</p>'.repeat(100)+'<img src="https://cdn.nlark.com/test.png">'});
function fixture() {
  const book={id:'10',namespace:'me/book',name:'笔记',items_count:3,excluded_unpublished:0,docs:[doc(1),doc(2),doc(3)],toc:[]};
  const state={schema:1,kind:'yuque-browser-batch',run_id:'test-run',owner_id:'9',owner_login:'me',inventory_complete:true,
    books:[book],errors:[],jobs:{'10/1':{book_id:'10',status:'done'},'10/2':{book_id:'10',status:'pending'},'10/3':{book_id:'10',status:'failed',error:'version pending'}}};
  const snapshot={schema:1,kind:'yuque-browser-sample',run_id:state.run_id,owner_id:'9',owner_login:'me',
    book:{id:book.id,namespace:book.namespace,name:book.name},document:doc(1),assets:{'https://cdn.nlark.com/test.png':Buffer.from('test image').toString('base64')}};
  return {state,snapshot};
}
function setup(options={}) {
  const {state,snapshot}=fixture(),downloads=[],revoked=[],blobs=new Map();
  const storedKey=options.reused?'snapshot/older/10/1':'10/1';
  if(options.reused){
    snapshot.run_id='older';
    Object.assign(state.jobs['10/1'],{snapshot_run:'older',snapshot_key:storedKey});
  }
  const element=()=>({textContent:'',addEventListener(){},replaceChildren(){},append(){}});
  const elements=new Map();
  const context=vm.createContext({Blob,Response,TextEncoder,crypto:webcrypto,AbortSignal,setTimeout,
    CompressionStream:options.store?undefined:CompressionStream,
    URL:{createObjectURL:blob=>{blobs.set('blob:test',blob);return 'blob:test';},revokeObjectURL:url=>revoked.push(url)},
    document:{getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element},
    indexedDB:{open:()=>({})},navigator:{},state,
    load:async key=>{assert.equal(key,storedKey);return options.missing?undefined:{...snapshot,...(options.mismatch?{run_id:'wrong'}:{})};},
    chrome:{downloads:{download:async args=>{downloads.push(args);if(options.reject)throw Error('download rejected');return 1;},
      search:async()=>[{state:options.interrupted?'interrupted':'complete'}]}}
  });
  for(const f of ['collector-core.js','concurrency.js','batch-model.js','zip.js','batch.js'])
    vm.runInContext(fs.readFileSync('browser-collector/'+f,'utf8'),context);
  vm.runInContext('readRecord=load;',context);
  return {context,state,downloads,revoked,blobs,save:()=>vm.runInContext('save(state)',context)};
}
(async()=>{
  for(const store of [false,true]) {
    const r=setup({store,reused:!store}),before=JSON.stringify(r.state);
    await r.save();
    assert.equal(r.downloads.length,1);assert.equal(r.downloads[0].filename,'yuque-migration/test-run.zip');
    assert.equal(r.downloads[0].conflictAction,'uniquify');assert.deepEqual(r.revoked,['blob:test']);
    assert.equal(JSON.stringify(r.state),before);
    const blob=r.blobs.get('blob:test'),bytes=Buffer.from(await blob.arrayBuffer());
    assert.equal(blob.type,'application/zip');assert.equal(bytes.readUInt32LE(0),0x04034b50);
    assert.equal(bytes.readUInt16LE(8),store?0:8);
    if(process.argv[2])fs.writeFileSync(path.join(process.argv[2],store?'stored.zip':'compressed.zip'),bytes);
  }
  for(const options of [{missing:true},{mismatch:true},{reject:true},{interrupted:true}]) {
    const r=setup(options),before=JSON.stringify(r.state);
    await assert.rejects(r.save(),/缺失|身份|rejected|中断/);
    assert.equal(JSON.stringify(r.state),before);
    assert.equal(r.downloads.length,options.missing||options.mismatch?0:1);
    assert.equal(r.revoked.length,r.downloads.length);
  }
  const r=setup();r.state.jobs['10/1'].status='pending';await r.save();
  assert.equal(r.downloads.length,1); // Inventory-only ZIP still records unfinished work.
  if(process.argv[2])fs.writeFileSync(path.join(process.argv[2],'pending.zip'),Buffer.from(await r.blobs.get('blob:test').arrayBuffer()));
  const z=vm.runInContext('new SnapshotZip()',r.context);
  await z.addJSON('中文.json',{title:'中文 😀'});
  await assert.rejects(z.addJSON('中文.json',{}),/重复/);
  await assert.rejects(z.addJSON('../escape.json',{}),/无效/);
  if(process.argv[2])fs.writeFileSync(path.join(process.argv[2],'unicode.zip'),Buffer.from(await z.finish().arrayBuffer()));
  const capped=vm.runInContext('new SnapshotZip()',r.context);capped.offset=0xffffffff-22;
  await assert.rejects(capped.addJSON('large.json',{}),/大小限制/);
  console.log('Single ZIP download, compression/fallback, UTF-8, size limits, incomplete inventory, failure and cancellation checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
