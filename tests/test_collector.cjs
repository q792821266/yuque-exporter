// Exercise resource selection without network requests or private source content.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto, createHash } = require("node:crypto");
let reviewRecords = [];
let nodes = {};
const element = attrs => ({
  getAttribute: key => attrs[key] ?? null,
  hasAttribute: key => Object.hasOwn(attrs, key),
});
const context = vm.createContext({
  URL,
  crypto: webcrypto,
  TextEncoder,
  fetch: async url => {
    assert.equal(url, "verified-versions.json");
    return { ok: true, json: async () => reviewRecords };
  },
  document: { getElementById: () => ({ addEventListener() {} }) },
  DOMParser: class {
    parseFromString() { return { querySelectorAll: selector => nodes[selector] || [] }; }
  },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../browser-collector/collector-core.js"), "utf8"), context);
const collect = () => Array.from(vm.runInContext('resourceURLs("")', context));
const external = "http://example.org/example.pdf";
const pictures = Array.from({ length: 15 }, (_, i) => `https://cdn.nlark.com/${i}.png`);
nodes = {
  img: pictures.map(src => element({ src })),
  "a[href]": [element({ href: external }), element({ href: "https://cdn.yuque.com/a.pdf" })],
};
assert.deepEqual(collect(), [...pictures, "https://cdn.yuque.com/a.pdf"]);
// External embedded images and explicit attachments must still fail closed.
nodes = { img: [element({ src: external })] };
assert.throws(collect, /不是 HTTPS/);
nodes = { "card,ne-card": [element({ name: "file", value: JSON.stringify({ src: external }) })] };
assert.throws(collect, /不是 HTTPS/);
nodes = { img: [element({ src: "https://unknown.example/private?token=SECRET" })] };
assert.throws(collect, error => error.message.includes("域名未授权") && !error.message.includes("SECRET") && !error.message.includes("private"));
console.log("Collector resource selection checks passed.");

async function checkVersions() {
  const record = { id: '101', book_id: '10', slug: 'fixture-article', title: 'Synthetic article',
    type: 'Doc', format: 'lake', status: 0, content_modified: true,
    published_at: '2025-01-01T00:00:00Z', content_updated_at: '2025-01-02T00:00:00Z',
    evidence: 'synthetic-test-only' };
  const content = '<p>published fixture</p>';
  reviewRecords = [{ ...record, content_sha256: createHash('sha256').update(content).digest('hex') }];
  context.sampleDoc = { ...record, content };
  const accepted = await vm.runInContext('requirePublished(sampleDoc)', context);
  assert.equal(accepted.method, 'reviewed-reading-page-sha256');
  for (const [key, value] of Object.entries({ content: content + 'changed', id: '999', book_id: '999', title: 'changed', published_at: '2026-10-27T00:00:00Z', deleted_at: '2026-10-27T00:00:00Z' })) {
    context.sampleDoc = { ...record, content, [key]: value };
    await assert.rejects(vm.runInContext('requirePublished(sampleDoc)', context));
  }
  reviewRecords = [];
  context.sampleDoc = { ...record, content };
  await assert.rejects(vm.runInContext('requirePublished(sampleDoc)', context));
  context.sampleDoc = { ...record, status: 1, content_modified: false, content_updated_at: record.published_at };
  assert.equal(await vm.runInContext('requirePublished(sampleDoc)', context), null);
  console.log('Collector reviewed-version acceptance and rejection checks passed.');
}
checkVersions().catch(error => { console.error(error); process.exitCode = 1; });
