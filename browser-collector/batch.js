/* A full extension page owns the queue; IndexedDB commits each complete article. */
const statusView = document.getElementById("status");
const controls = ["inventory","incremental","fresh","history","run","retry","save","all","limit","concurrency"].map(id=>document.getElementById(id));
let paused = false;
const dbReady = new Promise((resolve,reject)=>{
  const request = indexedDB.open("yuque-private-backup",1);
  request.onupgradeneeded = ()=>request.result.createObjectStore("records");
  request.onsuccess = ()=>resolve(request.result);
  request.onerror = ()=>reject(new Error("无法打开本机任务存储。"));
});
async function readRecord(key) {
  const db = await dbReady;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("records","readonly"), req=tx.objectStore("records").get(key);
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(new Error("读取本机任务失败。"));
  });
}
async function commit(state, key, snapshot) {
  const db = await dbReady;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction("records","readwrite"), store=tx.objectStore("records");
    tx.oncomplete=resolve;
    tx.onabort=tx.onerror=()=>reject(new Error("本机存储写入失败，可能空间不足；当前文章未提交。"));
    try {
      store.put(state,"state");
      if (key) store.put(snapshot,key);
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
function show(state, message) {
  statusView.textContent=message;
  const body=document.getElementById("books"); body.replaceChildren();
  for (const b of state?.books || []) {
    const tr=document.createElement("tr"), entries=Object.values(state.jobs || {}).filter(j=>j.book_id===b.id);
    for (const value of [b.name,b.docs?.length ?? "待盘点",entries.filter(j=>j.status==="done").length,entries.filter(j=>j.status==="failed").length]) {
      const td=document.createElement("td");td.textContent=String(value);tr.append(td);
    }
    body.append(tr);
  }
}
async function exclusive(work) {
  for (const c of controls) c.disabled=true;
  paused=false;
  try {
    await navigator.locks.request("yuque-private-backup-run",{ifAvailable:true},async lock=>{
      if (!lock) throw new Error("另一个采集页面正在运行，请使用那个页面。");
      await work(await readRecord("state"));
    });
  } catch(error) { statusView.textContent="未完成："+(error instanceof Error ? error.message : "未知错误"); }
  finally {for (const c of controls) c.disabled=false;syncLimit();}
}
async function verifyOwner(state) {
  const user=await get("/api/mine");
  if (String(user.id)!==state.owner_id || user.login!==state.owner_login) throw new Error("当前登录账号与本机任务不一致，停止。");
  return user;
}
async function reusableJob(previous, book, doc) {
  const key = book.id + "/" + doc.id;
  const job = previous.jobs[key];
  if (!job || job.status !== "done" || doc.status !== 1 || doc.content_modified !== false ||
      !Number.isFinite(Date.parse(doc.content_updated_at)) ||
      !(Date.parse(doc.published_at) >= Date.parse(doc.content_updated_at))) return null;
  const recordKey = job.snapshot_key || key;
  const sourceRun = job.snapshot_run || previous.run_id;
  const snapshot = await readRecord(recordKey);
  if (!snapshot || snapshot.owner_id !== previous.owner_id || snapshot.owner_login !== previous.owner_login ||
      snapshot.run_id !== sourceRun || snapshot.book?.namespace !== book.namespace ||
      String(snapshot.book.id) !== book.id || String(snapshot.document?.id) !== String(doc.id)) return null;
  const fields = ["slug","title","type","status","content_modified","published_at","content_updated_at"];
  if (!fields.every(field => doc[field] != null && snapshot.document[field] === doc[field])) return null;
  return {book_id: book.id, status: "done", snapshot_key: recordKey, snapshot_run: sourceRun};
}

async function inventory(state, previous = null, incremental = false) {
  if (state?.inventory_complete) {show(state,"目录盘点已完成，可开始或继续采集。此次任务保留其盘点时点，不会清除已完成文章。");return;}
  if (!state) {
    const user=previous ? await verifyOwner(previous) : await get("/api/mine"), books=ownBooks(await get("/api/mine/book_stacks"),user);
    state={schema:1,kind:"yuque-browser-batch",run_id:new Date().toISOString().replace(/[:.]/g,"-"),owner_id:String(user.id),owner_login:user.login,books,jobs:{},errors:[],next_book:0,inventory_complete:false};
    if (previous) {
      state.run_id += "-" + crypto.randomUUID();
      state.history = previous.inventory_complete ? [previous.run_id, ...(previous.history || [])] : (previous.history || []);
      state.isolated_snapshots = true;
    } else await commit(state);
  }
  await verifyOwner(state);
  for (;state.next_book<state.books.length;) {
    if (paused) {show(previous || state,previous ? "新任务盘点已取消，原任务可继续使用。" : "盘点已暂停，可以继续。");return;}
    const b=state.books[state.next_book]; show(state,`盘点 ${state.next_book+1}/${state.books.length}：${b.name}`);
    const docs=publishedRows(await get(`/api/docs?book_id=${encodeURIComponent(b.id)}`),b);
    const response=await fetch(ORIGIN+"/"+b.namespace,{credentials:"include",redirect:"error",cache:"no-store",signal:AbortSignal.timeout(45000)});
    if (!response.ok) throw new Error("知识库目录读取失败 HTTP "+response.status);
    const toc=extractTOC(await response.text(),b.id);
    b.docs=docs;b.toc=toc;b.excluded_unpublished=b.items_count-docs.length;
    for (const d of docs) {
      const reused = incremental && previous ? await reusableJob(previous,b,d) : null;
      state.jobs[b.id+"/"+d.id] = reused || {book_id:b.id,status:"pending"};
    }
    state.next_book++;
    if (!previous) await commit(state);
  }
  // Reject an inventory assembled across a changing account membership/count.
  const current=ownBooks(await get("/api/mine/book_stacks"),await verifyOwner(state));
  if (current.length!==state.books.length || current.some(b=>!state.books.some(old=>old.id===b.id && old.namespace===b.namespace && old.items_count===b.items_count))) throw new Error("盘点期间知识库或条目数量变化，未将本次盘点标记完整。请保留任务文件并报告此提示。");
  if (previous && paused) {show(previous,"原任务可继续使用。");return;}
  state.inventory_complete=true;state.inventoried_at=new Date().toISOString();
  // Switch tasks only after the new inventory is complete; archive and switch atomically.
  await commit(state, previous ? "history/"+previous.run_id : undefined, previous);
  renderHistory(state);
  show(state,"完整目录与已发布文档清单已保存到本机。可以开始采集。");
}
async function captureOne(state,b,d) {
  const path=`/api/docs/${encodeURIComponent(d.slug)}?book_id=${encodeURIComponent(b.id)}&merge_dynamic_data=true`;
  const doc=await get(path);
  if (String(doc.id)!==String(d.id) || String(doc.book_id)!==b.id || doc.slug!==d.slug) throw new Error("文档身份或知识库不匹配。");
  const evidence=await requirePublished(doc);
  if (typeof doc.content!=="string" || !doc.content.trim()) throw new Error("未取得可转换正文。");
  const assets=await collectAssets(resourceURLs(doc.content), (completed,total)=>{
    show(state,`采集 ${doc.title}，资源 ${completed}/${total}`);
  });
  const latest=await get(path);await requirePublished(latest);
  if (!sameCapture(doc,latest)) throw new Error("采集期间文档版本变化，请重试。");
  const safe=Object.fromEntries(["id","book_id","title","slug","type","status","format","content_modified","published_at","first_published_at","content_updated_at","content"].map(k=>[k,doc[k]]));
  return {schema:1,kind:"yuque-browser-sample",run_id:state.run_id,captured_at:new Date().toISOString(),owner_id:state.owner_id,owner_login:state.owner_login,book:{id:b.id,name:b.name,namespace:b.namespace},document:safe,version_evidence:evidence,assets};
}
async function run(state,retry,limit=null,concurrency=3) {
  if (!state?.inventory_complete) throw new Error("请先完成目录盘点。");
  if (limit!==null && (!Number.isInteger(limit) || limit<1 || limit>100)) throw new Error("每轮篇数须为 1 到 100 的整数，或选择全部。");
  if (!Number.isInteger(concurrency) || concurrency<1 || concurrency>4) throw new Error("同时采集篇数须为 1 到 4。");
  const user=await verifyOwner(state), current=ownBooks(await get("/api/mine/book_stacks"),user);
  const owned=new Set(current.filter(b=>state.books.some(old=>old.id===b.id && old.namespace===b.namespace)).map(b=>b.id));
  const eligible=state.books.flatMap(b=>b.docs.map(d=>({b,d,key:b.id+"/"+d.id})))
    .filter(({key})=>state.jobs[key].status===(retry?"failed":"pending"));
  const queue=limit===null?eligible:eligible.slice(0,limit);
  let attempted=0;
  // Network work runs concurrently; state and matching snapshots commit serially.
  // Never expose a done state before its body transaction succeeds.
  let writes=Promise.resolve(), storageError;
  function persistJob(key,job,snapshot) {
    const write=writes.then(async()=>{
      if (storageError) throw storageError;
      const next={...state,jobs:{...state.jobs,[key]:job}};
      try {await commit(next,snapshot ? (job.snapshot_key || key) : undefined,snapshot);}
      catch(error) {storageError=error;throw error;}
      state.jobs=next.jobs;
    });
    writes=write.catch(()=>{});
    return write;
  }
  await runPool(queue,concurrency,async ({b,d,key})=>{
    attempted++;
    show(state,`检查 ${attempted}/${queue.length}：${b.name} / ${d.title}`);
    let snapshot, captureError;
    try {
      if (!owned.has(b.id)) throw new Error("知识库不再属于当前账号。");
      snapshot=await captureOne(state,b,d);
    } catch(error) {
      captureError=error instanceof Error?error.message:"采集失败";
    }
    if (captureError) {
      await persistJob(key,{...state.jobs[key],status:"failed",error:captureError});
      show(state,`${d.title} 未完成：${captureError}`);
    } else {
      const job={...state.jobs[key],status:"done"};delete job.error;
      if (state.isolated_snapshots) job.snapshot_key="snapshot/"+state.run_id+"/"+key;
      await persistJob(key,job,snapshot);
    }
  },()=>paused || Boolean(storageError));
  if (paused) {show(state,"已暂停。正在采集的文章已处理完毕，下次从未完成处继续。");return;}
  const failures=Object.values(state.jobs).filter(j=>j.status==="failed").length;
  show(state,`本轮已检查 ${attempted} 篇，${failures} 篇失败或版本待核对。可继续采集或下载 ZIP；导入并校验后才算完成 Markdown 备份。`);
}
async function downloadBlob(blob,filename) {
  const url=URL.createObjectURL(blob);
  try {
    const id=await chrome.downloads.download({url,filename,saveAs:false,conflictAction:"uniquify"});
    const deadline=Date.now()+300000;
    while (Date.now()<deadline) {
      const [item]=await chrome.downloads.search({id});
      if (item?.state==="complete") return;
      if (!item || item.state==="interrupted") throw new Error("下载被取消或中断，浏览器本地任务仍保留，可重新下载。");
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error("下载等待超时，本地任务仍保留。");
  } finally {URL.revokeObjectURL(url);}
}
async function save(state) {
  if (!state?.inventory_complete) throw new Error("请先完成目录盘点。");
  if (!/^[\w-]+$/.test(state.run_id)) throw new Error("本机任务编号无效。");
  const filename="yuque-migration/"+state.run_id+".zip", archive=new SnapshotZip();
  const done=Object.entries(state.jobs).filter(([,job])=>job.status==="done");
  show(state,"正在准备 ZIP 采集包……");
  // Inventory includes failed/pending documents so imports cannot silently omit them.
  const {history, isolated_snapshots, ...inventory} = state;
  inventory.jobs = Object.fromEntries(Object.entries(state.jobs).map(([key,job])=>{
    const {snapshot_key, snapshot_run, ...publicJob} = job;
    return [key,publicJob];
  }));
  await archive.addJSON("inventory.json",{...inventory,sample_only:false,excluded_unpublished:state.books.reduce((n,b)=>n+(b.excluded_unpublished||0),0)});
  let packed=0;
  for (const [key,job] of done) {
    const snapshot=await readRecord(job.snapshot_key || key);if (!snapshot) throw new Error("本机任务正文缺失，未标记下载成功。");
    if (!/^\d+\/\d+$/.test(key) || snapshot.run_id!==(job.snapshot_run || state.run_id) || snapshot.owner_id!==state.owner_id ||
        snapshot.owner_login!==state.owner_login || key!==String(snapshot.book?.id)+"/"+String(snapshot.document?.id)) {
      throw new Error("本机任务正文身份不匹配，未生成采集包。");
    }
    show(state,`打包 ${++packed}/${done.length}：${snapshot.document.title}`);
    await archive.addJSON("doc-"+key.replace("/","-")+".json",{...snapshot,run_id:state.run_id});
  }
  show(state,"打包完成，正在保存 ZIP……");
  await downloadBlob(archive.finish(),filename);
  show(state,"采集包下载已完成："+filename+"。解压后将包含 inventory.json 的文件夹交给 import-batch 导入。");
}
function renderHistory(state) {
  const select = document.getElementById("history");
  select.replaceChildren();
  for (const id of [state.run_id, ...(state.history || [])]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = (id === state.run_id ? "当前 " : "历史 ") + id.slice(0,23);
    select.append(option);
  }
}
async function saveSelected(state) {
  const id = document.getElementById("history").value;
  if (state?.history?.includes(id)) {
    const archived = await readRecord("history/"+id);
    if (!archived || archived.run_id !== id || archived.owner_id !== state.owner_id) throw new Error("历史清单缺失或账号不匹配。");
    await save(archived);
  } else await save(state);
}
function syncLimit() {document.getElementById("limit").disabled=document.getElementById("all").checked;}
function selectedLimit() {return document.getElementById("all").checked?null:Number(document.getElementById("limit").value);}
document.getElementById("all").addEventListener("change",syncLimit);
syncLimit();
document.getElementById("inventory").addEventListener("click",()=>exclusive(inventory));
document.getElementById("incremental").addEventListener("click",()=>exclusive(previous=>inventory(null,previous,true)));
document.getElementById("fresh").addEventListener("click",()=>exclusive(previous=>inventory(null,previous,false)));
document.getElementById("run").addEventListener("click",()=>exclusive(state=>run(state,false,selectedLimit(),Number(document.getElementById("concurrency").value))));
document.getElementById("retry").addEventListener("click",()=>exclusive(state=>run(state,true,selectedLimit(),Number(document.getElementById("concurrency").value))));
document.getElementById("pause").addEventListener("click",()=>{paused=true;statusView.textContent="将停止安排新文章，等待正在采集的文章保存后暂停。";});
document.getElementById("save").addEventListener("click",()=>exclusive(saveSelected));
readRecord("state").then(state=>{
  if (state) renderHistory(state);
  show(state,state?"已恢复本机任务。请选择继续盘点、继续采集或下载。":"尚无本机任务，请先盘点目录。");
}).catch(()=>{statusView.textContent="无法读取本机存储，未开始采集。";});
