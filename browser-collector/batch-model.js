/* Pure protocol checks shared by the persistent collector and offline tests. */
function ownBooks(stacks, user) {
  if (!user || !/^\d+$/.test(String(user.id)) || !/^[\w.-]+$/.test(user.login) || !Array.isArray(stacks)) throw new Error("账号或知识库列表格式错误。");
  const seen = new Set(), result = [];
  for (const stack of stacks) {
    if (!Array.isArray(stack.books)) throw new Error("知识库分组格式发生变化。");
    for (const b of stack.books) {
      if (String(b.user_id || b.user?.id) !== String(user.id)) continue;
      if (!/^\d+$/.test(String(b.id)) || !/^[\w.-]+$/.test(b.slug) || !Number.isInteger(b.items_count) || b.items_count < 0) throw new Error("知识库缺少身份或条目数量，停止盘点。");
      if (seen.has(String(b.id))) continue;
      seen.add(String(b.id));
      result.push({id:String(b.id),name:b.name || b.slug,namespace:user.login+"/"+b.slug,items_count:b.items_count});
    }
  }
  return result;
}

function publishedRows(rows, book) {
  if (!Array.isArray(rows) || rows.length !== book.items_count) throw new Error("文档数量与知识库声明不一致，未假定列表完整。");
  const seen = new Set(), docs = [];
  for (const d of rows) {
    if (!/^\d+$/.test(String(d.id)) || seen.has(String(d.id))) throw new Error("文档 ID 缺失或重复。");
    seen.add(String(d.id));
    if (!d.deleted_at && d.published_at && [0,1,"0","1"].includes(d.status)) {
      if (!/^[\w-]+$/.test(d.slug)) throw new Error("文档路径格式错误。");
      docs.push(Object.fromEntries(["id","slug","title","type","status","published_at","content_updated_at","content_modified"].map(k=>[k,d[k]])));
    }
  }
  return docs;
}

function extractTOC(html, bookId) {
  for (const match of html.matchAll(/decodeURIComponent\("([^"\n]+)"\)/g)) {
    let data;
    try { data = JSON.parse(decodeURIComponent(match[1])); } catch { continue; }
    if (!Array.isArray(data?.book?.toc)) continue;
    if (bookId !== undefined && String(data.book.id) !== String(bookId)) throw new Error("目录所属知识库不匹配。");
    // No scripts are executed and no hidden document/draft fields are retained.
    const toc = data.book.toc.map(n=>Object.fromEntries(["type","uuid","parent_uuid","doc_id","title","url","slug","depth"].filter(k=>n[k] !== undefined).map(k=>[k,n[k]])));
    const nodes = new Map();
    for (const n of toc) {
      if (n.uuid) {if (nodes.has(n.uuid)) throw new Error("目录节点重复。"); nodes.set(n.uuid,n);}
    }
    for (const n of toc) {
      const seen = new Set(); let current = n;
      while (current.parent_uuid) {
        if (seen.has(current.parent_uuid) || !nodes.has(current.parent_uuid)) throw new Error("目录父节点缺失或循环。");
        seen.add(current.parent_uuid); current = nodes.get(current.parent_uuid);
      }
    }
    return toc;
  }
  throw new Error("未识别到完整目录，停止该库盘点。");
}

function sameCapture(a,b) {
  return ["id","book_id","slug","title","type","status","format","content_modified","published_at","content_updated_at","content"].every(k=>a[k]===b[k]) && !b.deleted_at;
}
