const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {buildRelease,metadata,files}=require('../scripts/build-release.cjs');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'yuque-release-test-'));
(async()=>{
 try {
  assert.throws(()=>metadata('v999.0.0'),/tag/);
  const first=await buildRelease(directory),bytes=fs.readFileSync(path.join(directory,first.name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),first.sha256);
  assert.equal(fs.readFileSync(path.join(directory,first.name+'.sha256'),'utf8'),first.sha256+'  '+first.name+'\n');
  assert.match(fs.readFileSync(path.join(directory,'RELEASE_NOTES.md'),'utf8'),/^## \[/);
  let offset=0;const names=[];
  while(bytes.readUInt32LE(offset)===0x04034b50) {
   assert.equal(bytes.readUInt16LE(offset+8),0);
   const size=bytes.readUInt32LE(offset+18),length=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
   const name=bytes.subarray(offset+30,offset+30+length).toString('utf8');
   const start=offset+30+length+extra,content=bytes.subarray(start,start+size).toString('utf8');
   assert.ok(name.startsWith('yuque-exporter/'));names.push(name.slice('yuque-exporter/'.length));
   assert.equal(content,fs.readFileSync(path.join(__dirname,'..',names.at(-1)),'utf8').replace(/\r\n/g,'\n'));
   offset=start+size;
  }
  assert.deepEqual(names,[...files].sort());assert.equal(bytes.readUInt32LE(offset),0x02014b50);
  const second=await buildRelease(directory,'v'+first.version);
  assert.equal(first.sha256,second.sha256);
  console.log('Release archive allowlist, file bytes, checksum, reproducibility and tag checks passed.');
 } finally {
  if(path.dirname(fs.realpathSync(directory))!==fs.realpathSync(os.tmpdir()))throw Error('Test cleanup escaped the temporary directory.');
  fs.rmSync(directory,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
