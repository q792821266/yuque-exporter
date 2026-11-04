const ORIGIN = "https://www.yuque.com";
const ALLOWED_ASSETS = new Set(["cdn.nlark.com", "cdn.yuque.com", "www.yuque.com"]);
const MAX_RESOURCE = 20 * 1024 * 1024;

async function get(path) {
  const response = await fetch(ORIGIN + path, {
    credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(45000),
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
  });
  if (!response.ok) throw new Error(`语雀读取失败 HTTP ${response.status}；检查登录与访问权限。`);
  const json = await response.json();
  if (!Object.hasOwn(json, "data")) throw new Error("接口缺少 data，停止采集。");
  return json.data;
}

async function requirePublished(doc) {
  const published = Date.parse(doc.published_at);
  const changed = Date.parse(doc.content_updated_at);
  if (doc.type !== "Doc") throw new Error("当前仅支持普通文档，未采集特殊格式。");
  if (doc.deleted_at) throw new Error("文章已删除，停止采集。");
  if (doc.status !== 1 || doc.content_modified !== false || !Number.isFinite(published) || !Number.isFinite(changed) || changed > published) {
    // Local reviewed pins, never trust a proof supplied by the remote document.
    const response = await fetch("verified-versions.json");
    if (!response.ok) throw new Error("本地版本核对记录无法读取，停止采集。");
    const records = await response.json();
    const record = records.find(r => String(doc.id) === r.id && String(doc.book_id) === r.book_id &&
      ["slug", "title", "type", "format", "status", "content_modified", "published_at", "content_updated_at"].every(k => doc[k] === r[k]));
    if (record && typeof doc.content === "string") {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(doc.content));
      const hash = Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
      if (hash === record.content_sha256) return { method: "reviewed-reading-page-sha256", content_sha256: hash, evidence: record.evidence };
    }
    throw new Error("当前文章的已发布版本尚不能独立确认，或存在未发布修改。未保存编辑稿；请勿为通过采集而发布不想发布的修改。");
  }
  return null;
}

function resourceURLs(html) {
  const dom = new DOMParser().parseFromString(html, "text/html");
  const urls = new Map();
  for (const card of dom.querySelectorAll("card,ne-card")) {
    const name = card.getAttribute("name");
    if (["image", "imageblock", "file", "attachment"].includes(name)) {
      const value = card.getAttribute("value") || "";
      const data = JSON.parse(decodeURIComponent(value.startsWith("data:") ? value.slice(5) : value));
      const src = data.src || data.url;
      if (!src) throw new Error("图片或附件卡片缺少来源地址。");
      urls.set(src, `卡片 ${name}`);
    }
  }
  for (const img of dom.querySelectorAll("img")) {
    if (img.hasAttribute("srcset")) throw new Error("响应式图片需进一步验证。");
    urls.set(img.getAttribute("src"), "img 图片");
  }
  for (const a of dom.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    // File suffixes on ordinary external links do not make them embedded assets.
    // Explicit image/file cards above remain mandatory, regardless of host.
    let url;
    try { url = new URL(href); } catch { continue; }
    if (ALLOWED_ASSETS.has(url.hostname) && /\.(?:pdf|zip|7z|rar|docx?|xlsx?|pptx?|mp[34]|png|jpe?g|gif|svg|csv|txt)(?:[?#]|$)/i.test(href) && !urls.has(href)) urls.set(href, "附件链接");
  }
  return [...urls].map(([raw, source], index) => {
    const label = `资源 ${index + 1}（${source}）`;
    let url;
    try {
      if (typeof raw !== "string" || !raw.trim()) throw new Error();
      url = new URL(raw);
    } catch {
      throw new Error(`${label}缺少有效的绝对 URL；未显示原始地址。`);
    }
    if (url.protocol !== "https:" || url.username || url.password || !ALLOWED_ASSETS.has(url.hostname)) {
      // Never include paths, query strings, user info or inline data in diagnostics.
      const reason = url.username || url.password ? "地址含用户信息" : url.protocol !== "https:" ? "不是 HTTPS" : "域名未授权";
      throw new Error(`${label}被拒绝：${reason}；协议=${url.protocol}；域名=${url.hostname || "无"}。未自动扩大权限，请提供这段错误文字以便定位。`);
    }
    url.hash = "";
    return url.href;
  });
}

async function downloadResource(url) {
  const response = await fetch(url, {
    credentials: new URL(url).origin === ORIGIN ? "include" : "omit",
    redirect: "error", referrer: ORIGIN + "/", signal: AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error(`资源读取失败 HTTP ${response.status}。`);
  if (response.headers.get("content-type")?.includes("text/html")) throw new Error("资源返回网页而非文件。");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > MAX_RESOURCE) {
      await reader.cancel();
      throw new Error("单资源超过 20 MiB 小样限制。");
    }
    chunks.push(item.value);
  }
  let binary = "";
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
  }
  return btoa(binary);
}
