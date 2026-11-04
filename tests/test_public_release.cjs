const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const expected=new Set([
  '.gitignore','README.md','PRIVACY.md','LICENSE','package.json','scripts/run-tests.cjs',
  ...['manifest.json','popup.html','popup.js','batch.html','batch.js','batch-model.js','collector-core.js','concurrency.js','zip.js','verified-versions.json','README.md'].map(n=>'browser-collector/'+n),
  ...['test_collector','test_batch_collector','test_batch_queue','test_concurrency','test_batch_download','test_public_release'].map(n=>'tests/'+n+'.cjs')
]);
function walk(dir,prefix='') {
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    if(!prefix&&entry.name==='.git')continue;
    const name=prefix+entry.name,full=path.join(dir,entry.name);
    assert.ok(!entry.isSymbolicLink(),'Symlink is not part of the public release: '+name);
    if(entry.isDirectory())walk(full,name+'/');
    else {
      assert.ok(expected.delete(name),'Unexpected public file: '+name);
      const content=fs.readFileSync(full,'utf8');
      for(const pattern of [/[A-Za-z]:[\\/](?:Users|Projects|Downloads)[\\/]/i, /gh[pousr]_[A-Za-z0-9]{20,}/,
        /github_pat_[A-Za-z0-9_]{20,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
        /https?:\/\/[^\s/]+:[^\s/]+@/]) {
        assert.ok(!pattern.test(content),'Potential private data in '+name);
      }
    }
  }
}
walk(root);
assert.equal(expected.size,0,'Missing public files: '+[...expected].join(', '));
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'browser-collector/verified-versions.json'),'utf8')),[]);
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).license,'MIT');
assert.match(fs.readFileSync(path.join(root,'LICENSE'),'utf8'),/^MIT License/);
const manifest=JSON.parse(fs.readFileSync(path.join(root,'browser-collector/manifest.json'),'utf8'));
assert.deepEqual(manifest.permissions,['activeTab','downloads']);
for(const html of ['popup.html','batch.html']) {
  const content=fs.readFileSync(path.join(root,'browser-collector',html),'utf8');
  for(const [,script]of content.matchAll(/<script src="([^"]+)"/g))
    assert.ok(fs.existsSync(path.join(root,'browser-collector',script)));
}
console.log('Public file allowlist, empty review records, credential patterns and extension entrypoints passed.');
