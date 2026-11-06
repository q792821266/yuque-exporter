const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const context=vm.createContext({console,URL,TextEncoder,TextDecoder,Uint8Array,atob,crypto:webcrypto});
for(const name of ['markdown.js','markdown-export.js'])vm.runInContext(fs.readFileSync('browser-collector/'+name,'utf8'),context);
const md=vm.runInContext('LakeMarkdown',context),bundle=vm.runInContext('MarkdownBundle',context);
const n=(tag,children=[],attrs={})=>({tag,children,attrs});
const card=(name,data)=>n('card',[],{name,value:'data:'+encodeURIComponent(JSON.stringify(data))});
assert.equal(md.render(n('p',['Hello ',n('strong',['world'])])),'Hello **world**\n');
assert.match(md.render(n('ol',[n('li',['first']),n('li',['second'])],{start:'3'})),/3\. first\n4\. second/);
assert.match(md.render(card('codeblock',{code:'a\n\n\n```\nb',mode:'js'})),/````js\na\n\n\n```\nb\n````/);
assert.equal(md.render(n('code',['`quoted`'])),'`` `quoted` ``\n');
assert.equal(md.render(card('math',{code:'\\(x^2\\)'})),'$x^2$\n');
assert.equal(md.render(card('math',{code:'$x^2$'})),'$x^2$\n');
assert.equal(md.render(card('math',{code:'$$x^2$$'})),'$$\nx^2\n$$\n');
assert.match(md.render(card('math',{code:'\\begin{aligned}a&=b\\\\c&=d\\end{aligned}'})),/^\$\$\n/);
assert.equal(md.render(n('p',['H',n('sub',['2']),'O'])),'H<sub>2</sub>O\n');
assert.throws(()=>md.render(card('unknown',{})),/未支持/);
assert.throws(()=>md.render(n('iframe',[])),/嵌入/);
assert.throws(()=>md.render(n('table',[n('tr',[n('td',['merge'],{colspan:'2'})])])),/合并/);
assert.throws(()=>md.render(n('input',[],{type:'checkbox'})),/勾选/);
assert.match(md.render(n('table',[n('tr',[n('td',['a|b']),n('td',['next',n('br'),'line'])])])),/a\\\|b.*next<br>line/);
assert.equal(bundle.safeName('../CON:'),'.._CON_');assert.equal(bundle.safeName('CON'),'_CON');
assert.throws(()=>bundle.decode('@@=='),/Base64/);
const source='https://cdn.nlark.com/picture.png';
const row=id=>({id,slug:'doc'+id,title:'Same title',format:'lake',book_id:10,content:'fixture'+id});
const state={inventory_complete:true,run_id:'new',owner_id:'9',owner_login:'me',books:[{id:'10',namespace:'me/book',name:'Notes',docs:[row(1),row(2),row(3)]}],
  jobs:{'10/1':{status:'done',snapshot_run:'old',snapshot_key:'snapshot/old/10/1'},'10/2':{status:'done'},'10/3':{status:'failed'}}};
const snap=id=>({run_id:id===1?'old':'new',owner_id:'9',owner_login:'me',book:{id:'10',namespace:'me/book'},document:row(id),assets:{[source]:Buffer.from('image bytes').toString('base64')}});
const tree=id=>n('p',[n('img',[],{src:source,alt:'image'}),n('a',['other'],{href:'https://www.yuque.com/me/book/doc'+(id===1?2:1)}),
 n('code',[source])]);
md.convert=(html,resolve)=>md.render(tree(Number(html.slice(-1))),resolve);
const zip=()=>({files:new Map(),async addText(name,text){assert.ok(!this.files.has(name));this.files.set(name,text);},async addBytes(name,bytes){assert.ok(!this.files.has(name));this.files.set(name,bytes);},async addJSON(name,data){this.files.set(name,JSON.stringify(data));}});
(async()=>{
 const archive=zip(),before=JSON.stringify(state);
 const report=await bundle.write(state,async key=>snap(Number(key.split('/')[1])),archive);
 assert.equal(report.success,2);assert.equal(report.pending.length,1);assert.equal(report.complete,false);
 assert.equal(report.asset_files,1);assert.equal(archive.files.size,5);assert.equal(JSON.stringify(state),before);
 const body=archive.files.get('Notes-10/Same title-1.md');
 assert.match(body,/\.\.\/assets\/[a-f0-9]{64}\.png/);
 assert.match(body,/\.\.\/Notes-10\/Same%20title-2.md/);assert.ok(body.includes('`'+source+'`'));
 const changedAsset=await bundle.write(state,async key=>{
  const id=Number(key.split('/')[1]),snapshot=snap(id);
  if(id===2)snapshot.assets[source]=Buffer.from('updated image bytes').toString('base64');
  return snapshot;
 },zip());
 assert.equal(changedAsset.asset_files,2); // Same URL across versions cannot share different bytes.
 await assert.rejects(bundle.write(state,async()=>({...snap(1),owner_id:'other'}),zip()),/身份/);
 await assert.rejects(bundle.write(state,async key=>({...snap(Number(key.split('/')[1])),assets:{}}),zip()),/图片/);
 md.convert=(html,resolve)=>md.render(n('a',['unsafe'],{href:'javascript:alert(1)'}),resolve);
 await assert.rejects(bundle.write(state,async key=>snap(Number(key.split('/')[1])),zip()),/协议/);
 md.convert=(html,resolve)=>md.render(card('file',{src:'https://cdn.nlark.com/missing.pdf',name:'Attachment'}),resolve);
 await assert.rejects(bundle.write(state,async key=>snap(Number(key.split('/')[1])),zip()),/附件/);
 md.convert=(html,resolve)=>md.render(n('a',['unavailable'],{href:'https://www.yuque.com/me/book/doc3'}),resolve);
 const warnings=await bundle.write(state,async key=>snap(Number(key.split('/')[1])),zip());
 assert.equal(warnings.warnings.length,2);assert.equal(warnings.asset_files,0);
 console.log('Markdown rendering, code/math/tables, incomplete jobs, reused snapshots, asset deduplication, local links and rejection checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
