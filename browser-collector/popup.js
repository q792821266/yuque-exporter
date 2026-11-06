/* A user-triggered single-document collector. No cookie/password APIs or writes. */
const output = document.getElementById("status");
const capture = document.getElementById("capture");
const markdownCapture = document.getElementById("capture-markdown");
let capturing = false;
async function captureArticle(format) {
  if (capturing) return;
  capturing = true;
  capture.disabled = markdownCapture.disabled = true;
  try {
    output.textContent = "验证当前文章和账号身份……";
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const match = tab?.url?.match(/^https:\/\/www\.yuque\.com\/([\w.-]+)\/([\w.-]+)\/([\w-]+)(?:[?#]|$)/);
    if (!match) throw new Error("请在当前标签页打开语雀文章阅读页。");
    const namespace = match[1] + "/" + match[2];
    const user = await get("/api/mine");
    if (!user?.id || user.login !== match[1]) throw new Error("当前文章不属于本次登录的个人账号。");
    const stacks = await get("/api/mine/book_stacks");
    if (!Array.isArray(stacks)) throw new Error("自有知识库列表格式发生变化。");
    const book = stacks.flatMap(stack => stack.books || []).find(b => b.slug === match[2] && String(b.user_id || b.user?.id) === String(user.id));
    if (!book) throw new Error("未找到可确认所有权的知识库。");
    const doc = await get(`/api/docs/${encodeURIComponent(match[3])}?book_id=${encodeURIComponent(book.id)}&merge_dynamic_data=true`);
    if (!/^\d+$/.test(String(doc.id)) || String(doc.book_id) !== String(book.id) || doc.slug !== match[3]) throw new Error("正文身份或所属知识库不匹配。");
    const versionEvidence = await requirePublished(doc);
    if (typeof doc.content !== "string" || !doc.content.trim()) throw new Error("未获取到可转换正文。");
    const urls = [...new Set(resourceURLs(doc.content))];
    const assets = await collectAssets(urls, (completed, total) => {
      output.textContent = `读取资源 ${completed}/${total}……`;
    });
    // Recheck after resource downloads: a concurrently edited article must not be
    // silently mixed with resources from another revision.
    const latest = await get(`/api/docs/${encodeURIComponent(match[3])}?book_id=${encodeURIComponent(book.id)}&merge_dynamic_data=true`);
    await requirePublished(latest);
    if (!sameCapture(doc,latest)) throw new Error("采集期间文章发生变化，请稍后重试。");
    const safe = {};
    for (const key of ["id", "book_id", "title", "slug", "type", "status", "format", "content_modified", "published_at", "first_published_at", "content_updated_at", "content"]) safe[key] = doc[key];
    const snapshot = { schema: 1, kind: "yuque-browser-sample", captured_at: new Date().toISOString(), owner_id: String(user.id), owner_login: user.login, book: { id: String(book.id), namespace, name: book.name || book.slug }, document: safe, version_evidence: versionEvidence, assets };
    if (format === "markdown") {
      output.textContent = "正在转换 Markdown 并打包本地资源……";
      const archive = new SnapshotZip();
      const report = await MarkdownBundle.writeSingle(snapshot,archive);
      const filename = "yuque-migration/"+MarkdownBundle.safeName(doc.title)+"-"+doc.id+"-markdown.zip";
      output.textContent = "正在保存 Markdown ZIP，请保持窗口打开……";
      await downloadBlob(archive.finish(),filename);
      output.textContent = `Markdown 下载完成：${doc.title}，${report.asset_files} 个本地资源，${report.warnings.length} 条链接提示。解压后打开 README.md 查看文章。`;
    } else {
      output.textContent = "正在保存 JSON，请保持窗口打开……";
      await downloadBlob(new Blob([JSON.stringify(snapshot)],{type:"application/json;charset=utf-8"}),`yuque-sample-${doc.id}.json`,{saveAs:true});
      output.textContent = `JSON 下载完成：${doc.title}，${urls.length} 个资源。文件含私密原文，请仅保存到本机私密目录。`;
    }
  } catch (error) {
    output.textContent = "采集或下载未完成：" + (error instanceof Error ? error.message : "未知错误");
  } finally {
    capture.disabled = markdownCapture.disabled = false;
    capturing = false;
  }
}
capture.addEventListener("click",()=>captureArticle("json"));
markdownCapture.addEventListener("click",()=>captureArticle("markdown"));
