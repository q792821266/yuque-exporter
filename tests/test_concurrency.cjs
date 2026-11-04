const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const context=vm.createContext({});
vm.runInContext(fs.readFileSync('browser-collector/concurrency.js','utf8'),context);
(async()=>{
  let active=0,peak=0,calls=[];
  context.downloadResource=async url=>{
    calls.push(url);peak=Math.max(peak,++active);
    await delay(5);active--;return 'YWJj';
  };
  const results=await Promise.all(Array.from({length:3},(_,doc)=>context.collectAssets(
    Array.from({length:7},(_,i)=>`${doc}/${i}`).concat(`${doc}/0`))));
  assert.equal(peak,4);assert.equal(active,0);assert.equal(calls.length,21);
  results.forEach(r=>assert.equal(Object.keys(r).length,7));
  calls=[];
  context.downloadResource=async url=>{
    calls.push(url);active++;
    try {if(url===0)throw Error('resource failed');await delay(10);return 'YWJj';}
    finally {active--;}
  };
  await assert.rejects(context.collectAssets([0,1,2,3,4,5,6]),/resource failed/);
  assert.equal(active,0);assert.deepEqual(calls,[0,1,2,3]);
  context.downloadResource=async()=>({length:81*1024*1024});
  await assert.rejects(context.collectAssets(['large']),/80 MiB/);
  // Slots remain usable after failure; no stale work can leak into a new run.
  context.downloadResource=async()=>'';
  assert.equal(Object.keys(await context.collectAssets(['next'])).length,1);
  console.log('Global resource bound, deduplication, error drain, size cap and recovery passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
