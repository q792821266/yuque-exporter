/* Shared download completion and cancellation handling. */
async function downloadBlob(blob,filename,{saveAs=false}={}) {
  const url=URL.createObjectURL(blob);
  try {
    const id=await chrome.downloads.download({url,filename,saveAs,conflictAction:"uniquify"});
    const deadline=Date.now()+300000;
    while (Date.now()<deadline) {
      const [item]=await chrome.downloads.search({id});
      if (item?.state==="complete") return;
      if (!item || item.state==="interrupted") throw new Error("下载被取消或中断，请重新下载。");
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error("下载等待超时，请检查浏览器下载列表。");
  } finally {URL.revokeObjectURL(url);}
}
