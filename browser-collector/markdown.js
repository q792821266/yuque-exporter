/* Conservative Lake-to-Markdown conversion. No network requests or HTML execution.
 * Unsupported structures stop the export; the original snapshot stays available.
 */
const LakeMarkdown = (() => {
  function parse(html) {
    const template = document.createElement("template");
    // HTML ignores self-closing syntax on unknown tags. Expand Yuque's empty
    // cursor marker so the browser does not wrap the following prose in it.
    template.innerHTML = html.replace(/<cursor\s*\/>/gi,"<cursor></cursor>"); // Inert, including images.
    function tree(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType === 8) return "";
      return {tag: node.localName || "root", attrs: Object.fromEntries(Array.from(node.attributes || [], a => [a.name,a.value])),
        children: Array.from(node.childNodes, tree)};
    }
    return tree(template.content);
  }
  const escape = value => String(value).replace(/\u200b/g, "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/[\\*\[\]`_]/g,"\\$&");
  const plain = node => typeof node === "string" ? node : node.children.map(plain).join("");
  function descendants(node, tag) {
    return node.children.flatMap(c => typeof c === "string" ? [] : c.tag === tag ? [c] : descendants(c,tag));
  }
  function fence(code, language="") {
    const ticks = "`".repeat(Math.max(3,...Array.from(code.matchAll(/`+/g), m => m[0].length+1)));
    const mode = /^[\w.+#-]*$/.test(language) ? language : "";
    return `\n\n${ticks}${mode}\n${code.replace(/\s+$/,"")}\n${ticks}\n\n`;
  }
  function cardData(raw) {
    try {
      const text = raw.startsWith("data:application/json;base64,")
        ? new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(atob(raw.split(",")[1]),c=>c.charCodeAt(0)))
        : decodeURIComponent(raw.startsWith("data:") ? raw.slice(5) : raw);
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
      return data;
    } catch { throw new Error("Lake 卡片数据无法转换。"); }
  }
  function normalize(markdown) {
    const lines=[];let character=null,size=0,blank=false;
    for(const line of markdown.split(/\r?\n/)) {
      const stripped=line.trimStart(), marker=stripped.match(/^(`{3,}|~{3,})/);
      if(character) {
        lines.push(line);
        if(marker && marker[1][0]===character && marker[1].length>=size && !stripped.slice(marker[1].length).trim())character=null;
        blank=false;
      } else if(marker) {character=marker[1][0];size=marker[1].length;lines.push(line);blank=false;}
      else if(!line.trim()){if(!blank)lines.push("");blank=true;}
      else{lines.push(line);blank=false;}
    }
    return lines.join("\n").trim()+"\n";
  }
  function render(root, resolve=uri=>uri, parser=parse) {
    function link(label, uri, image=false, required=false) {
      if(typeof uri!=="string" || !uri)throw new Error("链接或图片缺少地址。");
      const target=resolve(uri,image,required).replace(/[<>\s]/g,c=>encodeURIComponent(c));
      return `${image ? "!" : ""}[${label}](<${target}>)`;
    }
    function visit(node) {
      if(typeof node === "string")return escape(node);
      const {tag,attrs:a,children}=node;
      if(tag==="cursor" && !Object.keys(a).length && !children.length)return "";
      if(["script","style","iframe","svg","video","audio","object","embed"].includes(tag))throw new Error("正文包含暂不支持的嵌入内容。");
      if(tag==="card" || tag==="ne-card") {
        const name=a.name,d=cardData(a.value || "");
        if(name==="hr")return "\n\n---\n\n";
        if(name==="label" && typeof d.label==="string")return escape(d.label);
        if(name==="table" && typeof d.html==="string") {
          const tree=parser(d.html),tables=descendants(tree,"table");
          if(tables.length!==1)throw new Error("表格卡片结构无效。");
          const rows=descendants(tables[0],"tr");
          if(rows.length!==d.rows || rows.some(row=>row.children.filter(c=>typeof c!=="string" && ["td","th"].includes(c.tag)).length!==d.cols))throw new Error("表格卡片行列不一致。");
          return visit(tree);
        }
        if(["codeblock","code"].includes(name) && typeof d.code==="string")return fence(d.code,String(d.mode || d.language || ""));
        if(["image","imageblock"].includes(name) && typeof d.src==="string")return link(escape(d.alt || ""),d.src,true);
        if(["file","attachment"].includes(name) && typeof (d.src || d.url)==="string")return link(escape(d.name || "附件"),d.src || d.url,false,true);
        if(["math","formula"].includes(name) && typeof (d.code || d.value)==="string") {
          let code=(d.code || d.value).trim();
          const display=(code.startsWith("\\[") && code.endsWith("\\]")) || (code.startsWith("$$") && code.endsWith("$$"));
          if((code.startsWith("\\(") && code.endsWith("\\)")) || (code.startsWith("\\[") && code.endsWith("\\]")))code=code.slice(2,-2).trim();
          if(code.startsWith("$$") && code.endsWith("$$"))code=code.slice(2,-2).trim();
          else if(code.startsWith("$") && code.endsWith("$"))code=code.slice(1,-1).trim();
          if(display || code.includes("\n") || /\\begin\{|\\\\/.test(code))return `\n\n$$\n${code}\n$$\n\n`;
          return "$"+code+"$";
        }
        if(name==="yuqueinline" && d.mode==="title" && typeof d.detail?.title==="string" && typeof d.src==="string")return link(escape(d.detail.title),d.src);
        throw new Error("存在未支持的 Lake 卡片，未生成不完整 Markdown。");
      }
      if(tag==="pre") {const code=descendants(node,"code")[0] || node;return fence(plain(code),(code.attrs.class || "").replace(/^language-/,""));}
      if(tag==="code") {
        const value=plain(node),ticks="`".repeat(Math.max(1,...Array.from(value.matchAll(/`+/g),m=>m[0].length+1)));
        const padding=value.startsWith("`") || value.endsWith("`") || (/^ .* $/.test(value) && value.trim()) ? " " : "";
        return ticks+padding+value+padding+ticks;
      }
      if(tag==="table") {
        const matrix=descendants(node,"tr").map(row=>row.children.filter(c=>typeof c!=="string" && ["td","th"].includes(c.tag)).map(cell=>{
          if((cell.attrs.rowspan || "1")!=="1" || (cell.attrs.colspan || "1")!=="1")throw new Error("合并单元格表格需人工复核。");
          return cell.children.map(visit).join("").trim().replace(/\|/g,"\\|").replace(/\s*\n\s*/g,"<br>");
        }));
        if(!matrix.length)return "";
        const width=Math.max(...matrix.map(r=>r.length));for(const row of matrix)while(row.length<width)row.push("");
        matrix.splice(1,0,Array(width).fill("---"));
        return "\n\n"+matrix.map(row=>"| "+row.join(" | ")+" |").join("\n")+"\n\n";
      }
      if(tag==="details") {
        const summary=children.find(c=>typeof c!=="string" && c.tag==="summary");
        const label=(summary ? plain(summary) : "详情").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
        return `\n\n<details${Object.hasOwn(a,"open") ? " open" : ""}>\n<summary>${label}</summary>\n\n${children.filter(c=>c!==summary).map(visit).join("").trim()}\n\n</details>\n\n`;
      }
      if(tag==="ul" || tag==="ol") {
        const start=tag==="ol" ? Number(a.start || 1) : 1;
        if(!Number.isSafeInteger(start))throw new Error("列表编号无效。");
        return "\n\n"+children.filter(c=>typeof c!=="string" && c.tag==="li").map((c,i)=>{
          const marker=tag==="ol" ? `${start+i}. ` : "- ";
          return marker+c.children.map(visit).join("").trim().replace(/\n/g,"\n"+" ".repeat(marker.length));
        }).join("\n")+"\n\n";
      }
      const content=children.map(visit).join("");
      if(/^h[1-6]$/.test(tag))return "\n\n"+"#".repeat(Number(tag[1]))+" "+content.trim()+"\n\n";
      if(["strong","b"].includes(tag))return "**"+content+"**";
      if(["em","i"].includes(tag))return "*"+content+"*";
      if(["s","del"].includes(tag))return "~~"+content+"~~";
      if(tag==="a")return link(content,a.href);
      if(tag==="img") {if(a.srcset)throw new Error("响应式图片需核实资源集合。");return link(escape(a.alt || ""),a.src,true);}
      if(tag==="blockquote")return "\n\n"+content.trim().split("\n").map(l=>"> "+l).join("\n")+"\n\n";
      if(tag==="br")return "  \n";
      if(tag==="hr")return "\n\n---\n\n";
      if(["p","div","section","article","summary"].includes(tag))return content.trim() ? "\n\n"+content.trim()+"\n\n" : "";
      if(tag==="sup" || tag==="sub")return `<${tag}>${content}</${tag}>`;
      if(!["root","html","head","body","span","font","u","li","input","meta","link","wbr","colgroup","col"].includes(tag))throw new Error("正文包含尚未支持的 HTML 元素："+tag);
      if(tag==="input")throw new Error("勾选框内容需复核，未忽略其状态。");
      return content;
    }
    return normalize(visit(root));
  }
  return {parse,render,escape,convert:(html,resolve)=>render(parse(html),resolve)};
})();
