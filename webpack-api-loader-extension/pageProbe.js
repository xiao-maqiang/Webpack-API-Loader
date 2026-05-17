(function webpackApiLoaderProbe() {
  const seenGlobals = [];
  const chunkIds = new Set();
  const chunkGlobals = [];

  for (const key of Object.keys(window)) {
    if (!/^(webpackJsonp|webpackChunk|webpackHotUpdate)/.test(key)) {
      continue;
    }

    const value = window[key];
    chunkGlobals.push(key);

    if (Array.isArray(value)) {
      for (const entry of value) {
        collectChunkEntry(entry);
      }
    }

    seenGlobals.push({
      name: key,
      type: Array.isArray(value) ? "array" : typeof value,
      length: Array.isArray(value) ? value.length : undefined
    });
  }

  function collectChunkEntry(entry) {
    if (!Array.isArray(entry)) {
      return;
    }

    const ids = Array.isArray(entry[0]) ? entry[0] : [entry[0]];
    for (const id of ids) {
      if (id !== undefined && id !== null) {
        chunkIds.add(String(id));
      }
    }
  }

  window.postMessage({
    source: "webpack-api-loader",
    type: "probe-result",
    payload: {
      href: location.href,
      chunkGlobals,
      seenGlobals,
      chunkIds: Array.from(chunkIds)
    }
  }, "*");
})();
