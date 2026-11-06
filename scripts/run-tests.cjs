const {spawnSync}=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const name of ['test_public_release','test_collector','test_batch_collector','test_batch_queue','test_concurrency','test_batch_download','test_markdown','test_popup','test_release']) {
  const result=spawnSync(process.execPath,[path.join(root,'tests',name+'.cjs')],{cwd:root,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
