/* Bounded async I/O; wait for in-flight work before reporting errors or pause. */
async function runPool(items, concurrency, work, shouldStop = () => false) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("并发数无效。");
  let next = 0, failure;
  async function worker() {
    while (!failure && !shouldStop() && next < items.length) {
      const index = next++;
      try { await work(items[index], index); }
      catch (error) { failure ||= { error }; }
    }
  }
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, worker));
  if (failure) throw failure.error;
}

function createLimiter(concurrency) {
  let active = 0;
  const waiting = [];
  return async work => {
    if (active >= concurrency) await new Promise(resolve => waiting.push(resolve));
    else active++;
    try { return await work(); }
    finally {
      // Transfer the occupied slot directly to a waiter.
      if (waiting.length) waiting.shift()();
      else active--;
    }
  };
}

const resourceSlot = createLimiter(4);
async function collectAssets(urls, onProgress = () => {}) {
  const unique = [...new Set(urls)], assets = {};
  let bytes = 0, completed = 0, failed = false;
  await runPool(unique, 4, async url => {
    try {
      await resourceSlot(async () => {
        if (failed) return;
        const value = await downloadResource(url);
        bytes += value.length;
        if (bytes > 80 * 1024 * 1024) throw new Error("单篇资源编码总量超过 80 MiB，未提交此篇。");
        assets[url] = value;
        onProgress(++completed, unique.length);
      });
    } catch (error) { failed = true; throw error; }
  });
  return assets;
}
