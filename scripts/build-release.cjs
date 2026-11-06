const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const runtimeFiles=['manifest.json','popup.html','popup.js','batch.html','batch.js','batch-model.js',
  'collector-core.js','concurrency.js','zip.js','markdown.js','markdown-export.js','download.js','verified-versions.json','README.md'];
const files=['README.md','PRIVACY.md','LICENSE','CHANGELOG.md',...runtimeFiles.map(name=>'browser-collector/'+name)];
function metadata(tag) {
  const version=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'browser-collector/manifest.json'),'utf8'));
  if(!/^\d+\.\d+\.\d+$/.test(version) || manifest.version!==version)throw Error('Package and extension versions must match.');
  if(tag && tag!=='v'+version)throw Error('Release tag must match the package version.');
  if(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'browser-collector/verified-versions.json'),'utf8')))!=='[]')throw Error('Public release must not contain private review records.');
  const changelog=fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8').replace(/\r\n/g,'\n');
  const section=changelog.split(/^## /m).find(part=>part.startsWith('['+version+']'));
  if(!section || !section.includes('\n- '))throw Error('Current version needs changelog entries.');
  return {version,notes:'## '+section.trim()+'\n'};
}
async function buildRelease(output,tag) {
  const {version,notes}=metadata(tag);
  const Zip=vm.runInNewContext(fs.readFileSync(path.join(root,'browser-collector/zip.js'),'utf8')+'\nSnapshotZip;',
    {Blob,TextEncoder,Uint8Array}); // STORE yields identical bytes across Node/zlib versions.
  const archive=new Zip();
  for(const name of [...files].sort()) {
    const full=path.join(root,name);
    if(!fs.lstatSync(full).isFile() || fs.lstatSync(full).isSymbolicLink())throw Error('Release input must be a regular file: '+name);
    await archive.addText('yuque-exporter/'+name,fs.readFileSync(full,'utf8').replace(/\r\n/g,'\n'));
  }
  const bytes=Buffer.from(await archive.finish().arrayBuffer()),name=`yuque-exporter-${version}.zip`;
  const hash=createHash('sha256').update(bytes).digest('hex');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,name),bytes);
  fs.writeFileSync(path.join(output,name+'.sha256'),hash+'  '+name+'\n');
  fs.writeFileSync(path.join(output,'RELEASE_NOTES.md'),notes);
  return {version,name,sha256:hash,files:files.length};
}
module.exports={buildRelease,metadata,files};
if(require.main===module) {
  const check=spawnSync(process.execPath,[path.join(root,'tests/test_public_release.cjs')],{cwd:root,stdio:'inherit'});
  if(check.error)throw check.error;
  if(check.status!==0)process.exit(check.status || 1);
  buildRelease(path.resolve(process.argv[2] || path.join(root,'dist')),process.env.RELEASE_TAG)
    .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
