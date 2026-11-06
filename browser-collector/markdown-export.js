/* Build a self-contained reading bundle from stored snapshots, entirely offline. */
const MarkdownBundle = (() => {
  const extensions=new Set("png jpg jpeg gif webp svg bmp pdf zip rar 7z doc docx xls xlsx ppt pptx csv txt mp4 mp3 wav webm mov".split(" "));
  function safeName(value) {
    let name=Array.from(String(value || "无标题").replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,"_").trim()).slice(0,60).join("").replace(/[. ]+$/,"");
    if(!name || /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(name))name="_"+(name || "无标题");
    return name;
  }
  const encodePath=path=>path.split("/").map(encodeURIComponent).join("/");
  function canonical(raw) {const url=new URL(raw);url.hash="";return url.href;}
  function decode(value) {
    if(typeof value!=="string" || !value.length || value.length>28*1024*1024 || value.length%4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new Error("图片或附件的 Base64 数据无效或过大。");
    const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));
    if(bytes.length>20*1024*1024)throw new Error("图片或附件超过单资源限制。");
    return bytes;
  }
  async function write(state, load, archive, progress=()=>{}) {
    if(!state?.inventory_complete)throw new Error("请先完成目录盘点。");
    const targets=new Map(),documents=[],pending=[];
    for(const book of state.books) {
      if(!/^\d+$/.test(book.id) || !/^[\w.-]+\/[\w.-]+$/.test(book.namespace))throw new Error("知识库身份无效。");
      for(const doc of book.docs) {
        if(!/^\d+$/.test(String(doc.id)) || !/^[\w-]+$/.test(doc.slug))throw new Error("文章身份无效。");
        const key=book.id+"/"+doc.id,job=state.jobs[key];
        if(!job || !["done","pending","failed"].includes(job.status))throw new Error("文章队列状态无效。");
        if(job.status!=="done") {pending.push({document:key,title:doc.title,status:job.status});continue;}
        const path=safeName(book.name)+"-"+book.id+"/"+safeName(doc.title)+"-"+doc.id+".md";
        const sourcePath="/"+book.namespace+"/"+doc.slug;
        if(targets.has(sourcePath))throw new Error("文章来源路径重复。");
        targets.set(sourcePath,path);documents.push({book,doc,key,job,path,sourcePath});
      }
    }
    const report={schema:1,kind:"yuque-markdown-bundle",run_id:state.run_id,success:0,complete:false,
      pending,documents:[],warnings:[],asset_files:0};
    const packed=new Set();
    for(const item of documents) {
      const {book,doc,key,job,path,sourcePath}=item;
      progress(report.success+1,documents.length,doc.title);
      const snapshot=await load(key,job);
      if(!snapshot || snapshot.run_id!==(job.snapshot_run || state.run_id) || snapshot.owner_id!==state.owner_id || snapshot.owner_login!==state.owner_login ||
         String(snapshot.book?.id)!==book.id || snapshot.book.namespace!==book.namespace || String(snapshot.document?.id)!==String(doc.id) ||
         String(snapshot.document.book_id)!==book.id || snapshot.document.slug!==doc.slug)throw new Error("文章快照身份不匹配。");
      if(!["lake","html"].includes(snapshot.document.format) || typeof snapshot.document.content!=="string" || !snapshot.document.content.trim())throw new Error("文章正文格式不支持或内容缺失。");
      if(!snapshot.assets || typeof snapshot.assets!=="object" || Array.isArray(snapshot.assets))throw new Error("文章资源集合缺失。");
      const assets=new Map(),used=new Set(),warnings=new Set();let totalBase64=0;
      for(const [raw,value] of Object.entries(snapshot.assets)) {
        totalBase64+=typeof value==="string" ? value.length : 0;
        if(totalBase64>80*1024*1024)throw new Error("文章资源超过总量限制。");
        const url=new URL(raw);
        if(url.protocol!=="https:" || url.username || url.password || !["www.yuque.com","cdn.nlark.com","cdn.yuque.com"].includes(url.hostname))throw new Error("快照资源地址不在允许范围。");
        const bytes=decode(value),digest=await crypto.subtle.digest("SHA-256",bytes);
        const hash=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,"0")).join("");
        const suffix=url.pathname.split(".").pop().toLowerCase();
        const assetPath="assets/"+hash+"."+(extensions.has(suffix) ? suffix : "bin");
        const address=canonical(raw);
        if(assets.has(address) && assets.get(address).path!==assetPath)throw new Error("同一资源地址对应多份不同内容。");
        assets.set(address,{path:assetPath,value});
      }
      function resolve(raw,image,required) {
        if(raw.startsWith("#") && !image)return raw;
        let url;
        try {url=new URL(raw,"https://www.yuque.com"+sourcePath);}catch{throw new Error("文章链接无效。");}
        if(url.username || url.password || !["https:","http:","mailto:","tel:"].includes(url.protocol))throw new Error("文章链接协议不支持。");
        const asset=assets.get(canonical(url.href));
        if(asset){used.add(asset);return "../"+asset.path+url.hash;}
        if(image)throw new Error("文章引用的图片未包含在采集包中。");
        if(required || (["www.yuque.com","cdn.nlark.com","cdn.yuque.com"].includes(url.hostname) &&
          (extensions.has(url.pathname.split(".").pop().toLowerCase()) || url.pathname.includes("/attachments/"))))throw new Error("文章引用的附件未包含在采集包中。");
        if(["www.yuque.com","yuque.com"].includes(url.hostname)) {
          const target=targets.get(decodeURIComponent(url.pathname).replace(/\/$/,""));
          if(target)return "../"+encodePath(target)+url.hash;
          warnings.add("语雀链接目标未包含在本次 Markdown 包中，保留来源链接。");
        }
        if(extensions.has(url.pathname.split(".").pop().toLowerCase()))warnings.add("文件链接未包含本地资源，保留来源链接，离线阅读仍需联网。");
        return url.href;
      }
      let body;
      try {body=LakeMarkdown.convert(snapshot.document.content,resolve);}
      catch(error){throw new Error(`文章 ${doc.title} 转换失败：${error.message}`);}
      await archive.addText(path,"# "+LakeMarkdown.escape(doc.title).replace(/[\r\n]+/g," ")+"\n\n"+body);
      for(const asset of used)if(!packed.has(asset.path)) {
        await archive.addBytes(asset.path,decode(asset.value));packed.add(asset.path);
      }
      report.success++;report.documents.push({document:key,title:doc.title,path,captured_at:snapshot.captured_at});
      for(const warning of warnings)report.warnings.push({document:key,warning});
    }
    report.asset_files=packed.size;report.complete=!pending.length && !report.warnings.length;
    const index=["# 语雀 Markdown 备份","",`成功导出 ${report.success} 篇，未采集或失败 ${pending.length} 篇，链接提示 ${report.warnings.length} 条。`,
      "","图片和附件保存在 assets 目录，移动文件时请保持整个目录结构。公式使用 LaTeX，需要支持数学公式的 Markdown 阅读器。详细状态见 export-report.json。","",
      "内容可能包含私密文章，请勿直接上传公开仓库。",""];
    for(const book of state.books) {
      index.push("## "+LakeMarkdown.escape(book.name).replace(/[\r\n]+/g," "),"");
      for(const item of documents.filter(d=>d.book===book))index.push(`- [${LakeMarkdown.escape(item.doc.title).replace(/[\r\n]+/g," ")}](<${encodePath(item.path)}>)`);
      index.push("");
    }
    await archive.addText("README.md",index.join("\n"));await archive.addJSON("export-report.json",report);
    return report;
  }
  async function writeSingle(snapshot,archive,progress) {
    if(!snapshot?.book || !snapshot.document)throw new Error("单篇采集快照缺失。");
    const book={...snapshot.book,id:String(snapshot.book.id),docs:[snapshot.document]};
    const key=book.id+"/"+snapshot.document.id;
    const runId=snapshot.run_id || "single-"+snapshot.document.id;
    const state={inventory_complete:true,run_id:runId,owner_id:snapshot.owner_id,owner_login:snapshot.owner_login,
      books:[book],jobs:{[key]:{book_id:book.id,status:"done"}}};
    return write(state,async()=>({...snapshot,run_id:runId}),archive,progress);
  }
  return {write,writeSingle,safeName,decode};
})();
