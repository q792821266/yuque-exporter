const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const asset='https://cdn.nlark.com/synthetic.png';
const doc={id:1,book_id:10,slug:'article',title:'Single article',type:'Doc',format:'lake',status:1,content_modified:false,
 published_at:'2026-10-27T00:00:00Z',content_updated_at:'2026-10-27T00:00:00Z',content:'<p>published</p>'};
function setup(options={}) {
 const elements=new Map(),downloads=[],blobs=new Map(),revoked=[];let reads=0,searches=0;
 const element=()=>({disabled:false,textContent:'',addEventListener(event,fn){this[event]=fn;}});
 const ctx=vm.createContext({Blob,Response,TextEncoder,TextDecoder,Uint8Array,atob,crypto:webcrypto,CompressionStream,
  setTimeout:fn=>queueMicrotask(fn),AbortSignal,
  URL:class extends URL {static createObjectURL(blob){blobs.set('blob:single',blob);return 'blob:single';}static revokeObjectURL(url){revoked.push(url);}},
  document:{getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);}},
  chrome:{tabs:{query:async()=>[{url:options.invalidURL?'https://example.com/':'https://www.yuque.com/me/book/article'}]},
   downloads:{download:async args=>{downloads.push(args);if(options.cancel)throw Error('cancelled');return 1;},
    search:async()=>{searches++;return [{state:options.interrupted?'interrupted':searches===1?'in_progress':'complete'}];}}},
  fetch:async()=>({ok:true,json:async()=>[]}),
  response:async route=>{
   if(route==='/api/mine')return {id:9,login:options.otherOwner?'other':'me'};
   if(route==='/api/mine/book_stacks')return [{books:[{id:10,slug:'book',name:'Notes',user_id:9}]}];
   assert.equal(route,'/api/docs/article?book_id=10&merge_dynamic_data=true');reads++;
   return {...doc,...options.initial,...(reads===2?options.changed:{})};
  },asset,fixtureAssets:options.missingAsset?{}:{[asset]:Buffer.from('single image').toString('base64')}
 });
 for(const file of ['collector-core.js','concurrency.js','batch-model.js','zip.js','markdown.js','markdown-export.js','download.js','popup.js'])
  vm.runInContext(fs.readFileSync('browser-collector/'+file,'utf8'),ctx);
 vm.runInContext(`get=response;resourceURLs=()=>[asset];collectAssets=async()=>fixtureAssets;
 LakeMarkdown.convert=(_html,resolve)=>LakeMarkdown.render({tag:'p',attrs:{},children:[
 {tag:'img',attrs:{src:asset,alt:'image'},children:[]},
 {tag:'a',attrs:{href:'https://www.yuque.com/me/book/another'},children:['other article']}]},resolve);`,ctx);
 return {ctx,elements,downloads,blobs,revoked,run:format=>elements.get(format==='markdown'?'capture-markdown':'capture').click()};
}
(async()=>{
 const md=setup(),work=md.run('markdown');
 assert.equal(md.elements.get('capture').disabled,true);assert.equal(md.elements.get('capture-markdown').disabled,true);
 await md.run('json');await work; // A second click cannot start another capture.
 assert.equal(md.downloads.length,1);assert.equal(md.downloads[0].saveAs,false);
 assert.equal(md.downloads[0].filename,'yuque-migration/Single article-1-markdown.zip');
 assert.match(md.elements.get('status').textContent,/Markdown 下载完成.*1 条链接提示/);
 assert.deepEqual(md.revoked,['blob:single']);
 assert.equal(md.elements.get('capture').disabled,false);assert.equal(md.elements.get('capture-markdown').disabled,false);
 const original=setup();await original.run('json');
 assert.equal(original.downloads[0].filename,'yuque-sample-1.json');assert.equal(original.downloads[0].saveAs,true);
 const snapshot=JSON.parse(await original.blobs.get('blob:single').text());
 assert.equal(snapshot.kind,'yuque-browser-sample');assert.equal(snapshot.run_id,undefined);assert.equal(snapshot.document.id,1);
 for(const options of [{invalidURL:true},{otherOwner:true},{initial:{slug:'different'}},{initial:{status:0,content_modified:true}},
   {changed:{id:2}},{changed:{book_id:20}},{changed:{content:'changed'}},{changed:{content_updated_at:'2026-10-28T00:00:00Z'}},
   {missingAsset:true},{cancel:true},{interrupted:true}]) {
  const failed=setup(options);await failed.run('markdown');
  assert.match(failed.elements.get('status').textContent,/未完成/);
  assert.equal(failed.elements.get('capture').disabled,false);assert.equal(failed.elements.get('capture-markdown').disabled,false);
  assert.equal(failed.downloads.length,options.cancel||options.interrupted?1:0);
  assert.equal(failed.revoked.length,failed.downloads.length);
 }
 if(process.argv[2]) {
  fs.writeFileSync(path.join(process.argv[2],'single-markdown.zip'),Buffer.from(await md.blobs.get('blob:single').arrayBuffer()));
  fs.writeFileSync(path.join(process.argv[2],'single-json.json'),await original.blobs.get('blob:single').text());
 }
 console.log('Single-article Markdown/JSON downloads, local assets, source links, ownership/version checks, duplicate clicks and cancellation passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
