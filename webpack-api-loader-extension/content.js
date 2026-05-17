(() => {
  const STATIC_EXTENSIONS = /\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|mp4|mp3|wav|pdf|zip|rar|7z|gz|br)(?:[?#].*)?$/i;
  const SCRIPT_EXTENSIONS = /\.(?:js|mjs)(?:[?#].*)?$/i;
  const API_HINT = /(?:^|\/)(?:api|ajax|rest|graphql|gateway|oauth|auth|login|logout|user|admin|system|upload|download|file|v\d+)(?:\/|$|\?)/i;

  const state = {
    running: false,
    startedAt: null,
    finishedAt: null,
    pageUrl: location.href,
    pageTitle: document.title,
    scripts: new Map(),
    chunks: new Map(),
    apis: new Map(),
    findings: new Map(),
    probe: null,
    logs: []
  };

  injectProbe();
  collectInitialScripts();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node && node.tagName === "SCRIPT" && node.src) {
          rememberScript(node.src, "dom-observer");
        }
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "webpack-api-loader") {
      return;
    }

    if (event.data.type === "probe-result") {
      state.probe = event.data.payload;
      log(`Page probe found ${state.probe.chunkGlobals.length} webpack globals.`);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== "content") {
      return false;
    }

    if (message.action === "getState") {
      sendResponse({ ok: true, state: serializeState() });
      return false;
    }

    if (message.action === "clear") {
      clearState();
      sendResponse({ ok: true, state: serializeState() });
      return false;
    }

    if (message.action === "scan") {
      runScan(message.options || {})
        .then(() => sendResponse({ ok: true, state: serializeState() }))
        .catch((error) => {
          log(`Scan failed: ${error.message || error}`, "error");
          state.running = false;
          state.finishedAt = new Date().toISOString();
          sendResponse({ ok: false, error: error.message || String(error), state: serializeState() });
        });
      return true;
    }

    if (message.action === "export") {
      sendResponse({ ok: true, export: buildExport() });
      return false;
    }

    return false;
  });

  async function runScan(options) {
    const settings = {
      maxDepth: Number.isFinite(options.maxDepth) ? options.maxDepth : 3,
      maxScripts: Number.isFinite(options.maxScripts) ? options.maxScripts : 250,
      injectScripts: Boolean(options.injectScripts),
      includeSourceMaps: Boolean(options.includeSourceMaps)
    };

    state.running = true;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    log(`Scan started. maxDepth=${settings.maxDepth}, injectScripts=${settings.injectScripts}`);

    collectInitialScripts();
    await waitForProbe();

    const queue = [];
    for (const [url, item] of state.scripts) {
      queue.push({ url, depth: 0, source: item.source || "script-tag" });
    }

    let processed = 0;
    while (queue.length && processed < settings.maxScripts) {
      const job = queue.shift();
      const known = state.chunks.get(job.url) || {};
      if (known.status === "loaded" || known.status === "error") {
        continue;
      }

      processed += 1;
      rememberChunk(job.url, { depth: job.depth, source: job.source, status: "loading" });

      const response = await fetchText(job.url);
      if (!response.ok || !response.text) {
        rememberChunk(job.url, {
          depth: job.depth,
          source: job.source,
          status: "error",
          statusCode: response.status || 0,
          error: response.error || response.statusText || "Fetch failed"
        });
        continue;
      }

      const source = response.text;
      rememberChunk(job.url, {
        depth: job.depth,
        source: job.source,
        status: "loaded",
        statusCode: response.status,
        bytes: source.length,
        contentType: response.contentType || ""
      });

      const apis = extractApis(source, job.url);
      for (const api of apis) {
        rememberApi(api);
      }

      for (const finding of extractFindings(source, job.url)) {
        rememberFinding(finding);
      }

      if (settings.injectScripts && SCRIPT_EXTENSIONS.test(job.url)) {
        injectExternalScript(job.url);
      }

      if (job.depth >= settings.maxDepth) {
        continue;
      }

      const discovered = discoverChunkUrls(source, job.url, settings);
      for (const item of discovered) {
        if (!state.chunks.has(item.url)) {
          rememberChunk(item.url, {
            depth: job.depth + 1,
            source: item.source,
            status: "queued"
          });
          queue.push({ url: item.url, depth: job.depth + 1, source: item.source });
        }
      }
    }

    state.running = false;
    state.finishedAt = new Date().toISOString();
    log(`Scan finished. scripts=${state.chunks.size}, apis=${state.apis.size}`);
  }

  function collectInitialScripts() {
    for (const script of document.scripts) {
      if (script.src) {
        rememberScript(script.src, "script-tag");
      }
    }

    try {
      const entries = performance.getEntriesByType("resource") || [];
      for (const entry of entries) {
        if (entry.initiatorType === "script" && entry.name) {
          rememberScript(entry.name, "performance");
        }
      }
    } catch (error) {
      log(`Could not read performance entries: ${error.message}`, "warn");
    }
  }

  function rememberScript(rawUrl, source) {
    const url = absolutize(rawUrl, location.href);
    if (!url || !SCRIPT_EXTENSIONS.test(stripHash(url))) {
      return;
    }
    if (!state.scripts.has(url)) {
      state.scripts.set(url, { url, source, firstSeenAt: new Date().toISOString() });
    }
    if (!state.chunks.has(url)) {
      state.chunks.set(url, { url, source, status: "queued", depth: 0 });
    }
  }

  function rememberChunk(rawUrl, patch) {
    const url = absolutize(rawUrl, location.href);
    if (!url) {
      return;
    }
    const previous = state.chunks.get(url) || { url };
    state.chunks.set(url, { ...previous, ...patch, url, updatedAt: new Date().toISOString() });
  }

  function rememberApi(api) {
    const key = `${api.method || "ANY"} ${api.url}`;
    const previous = state.apis.get(key);
    if (previous) {
      previous.count += 1;
      previous.sources = Array.from(new Set([...(previous.sources || [previous.source]), api.source]));
      return;
    }
    state.apis.set(key, { ...api, sources: [api.source], count: 1, firstSeenAt: new Date().toISOString() });
  }

  function rememberFinding(finding) {
    const key = `${finding.type}:${finding.value}`;
    const previous = state.findings.get(key);
    if (previous) {
      previous.count += 1;
      previous.sources = Array.from(new Set([...(previous.sources || [previous.source]), finding.source]));
      return;
    }
    state.findings.set(key, { ...finding, sources: [finding.source], count: 1 });
  }

  async function fetchText(url) {
    try {
      const direct = await fetch(url, {
        cache: "no-store",
        credentials: "include",
        redirect: "follow"
      });
      const text = await direct.text();
      return {
        ok: direct.ok,
        status: direct.status,
        statusText: direct.statusText,
        contentType: direct.headers.get("content-type") || "",
        text,
        url: direct.url || url
      };
    } catch (error) {
      return chrome.runtime.sendMessage({
        target: "background",
        action: "fetchText",
        url
      });
    }
  }

  function discoverChunkUrls(source, baseUrl, settings) {
    const urls = new Map();
    const publicPaths = discoverPublicPaths(source, baseUrl);

    for (const raw of extractQuotedJsAssets(source)) {
      const absolute = absolutizeAsset(raw, baseUrl, publicPaths);
      if (absolute) {
        urls.set(absolute, { url: absolute, source: "quoted-js-asset" });
      }
    }

    for (const raw of extractSourceMapUrls(source, baseUrl, settings)) {
      const absolute = absolutizeAsset(raw, baseUrl, publicPaths);
      if (absolute) {
        urls.set(absolute, { url: absolute, source: "source-map" });
      }
    }

    for (const raw of extractWebpackMapCandidates(source, baseUrl, publicPaths)) {
      const absolute = absolutizeAsset(raw, baseUrl, publicPaths);
      if (absolute && SCRIPT_EXTENSIONS.test(stripHash(absolute))) {
        urls.set(absolute, { url: absolute, source: "webpack-map" });
      }
    }

    return Array.from(urls.values());
  }

  function discoverPublicPaths(source, baseUrl) {
    const paths = new Set([dirname(baseUrl), location.origin + "/"]);
    const patterns = [
      /__webpack_require__\.p\s*=\s*["']([^"']+)["']/g,
      /\b\w+\.p\s*=\s*["']([^"']+)["']/g,
      /publicPath\s*[:=]\s*["']([^"']+)["']/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source)) !== null) {
        const raw = decodeJsString(match[1]);
        const absolute = absolutize(raw, baseUrl);
        if (absolute) {
          paths.add(ensureTrailingSlash(absolute));
        }
      }
    }

    return Array.from(paths);
  }

  function extractQuotedJsAssets(source) {
    const results = new Set();
    const pattern = /["'`]((?:(?:https?:)?\/\/|\/|\.\/|\.\.\/)[^"'`<>\s()]{1,260}\.(?:js|mjs)(?:\?[^"'`<>\s()]*)?)["'`]/gi;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      results.add(decodeJsString(match[1]));
    }
    return Array.from(results);
  }

  function extractSourceMapUrls(source, baseUrl, settings) {
    if (!settings.includeSourceMaps) {
      return [];
    }
    const results = new Set();
    const pattern = /\/\/#\s*sourceMappingURL=([^\s]+)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      results.add(match[1].trim());
    }
    return Array.from(results);
  }

  function extractWebpackMapCandidates(source, baseUrl, publicPaths) {
    const candidates = new Set();
    const objectPattern = /\{((?:\s*["']?[\w.-]+["']?\s*:\s*["'][^"']{1,120}["']\s*,?){2,})\}/g;
    let objectMatch;

    while ((objectMatch = objectPattern.exec(source)) !== null) {
      const windowStart = Math.max(0, objectMatch.index - 220);
      const windowEnd = Math.min(source.length, objectPattern.lastIndex + 320);
      const nearby = source.slice(windowStart, windowEnd);
      if (!/\.js["']|chunk|__webpack_require__\.u|\.u\s*=/.test(nearby)) {
        continue;
      }

      const entries = parseObjectEntries(objectMatch[1]);
      if (entries.length < 2) {
        continue;
      }

      const after = source.slice(objectPattern.lastIndex, windowEnd);
      const before = source.slice(windowStart, objectMatch.index);
      const suffix = captureJsSuffix(after);
      const prefix = captureJsPrefix(before);

      for (const [id, value] of entries) {
        const safeId = String(id).replace(/^["']|["']$/g, "");
        const safeValue = decodeJsString(value);
        const fragments = new Set([
          `${safeId}.${safeValue}.js`,
          `${safeId}.${safeValue}.chunk.js`,
          `${safeId}.js`,
          `${safeValue}.js`
        ]);

        if (suffix) {
          fragments.add(`${safeId}.${safeValue}${suffix}`);
          fragments.add(`${safeId}${suffix}`);
        }
        if (prefix && suffix) {
          fragments.add(`${prefix}${safeId}.${safeValue}${suffix}`);
          fragments.add(`${prefix}${safeId}${suffix}`);
        }

        for (const fragment of fragments) {
          for (const publicPath of publicPaths) {
            const url = absolutize(fragment, publicPath);
            if (url) {
              candidates.add(url);
            }
          }
        }
      }
    }

    const uFunctionPattern = /\.u\s*=\s*(?:function\s*\([^)]*\)|\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>)[\s\S]{0,900}?["']([^"']*\.js[^"']*)["']/g;
    let uMatch;
    while ((uMatch = uFunctionPattern.exec(source)) !== null) {
      const fragment = decodeJsString(uMatch[2]);
      for (const publicPath of publicPaths) {
        const url = absolutize(fragment, publicPath);
        if (url) {
          candidates.add(url);
        }
      }
    }

    return Array.from(candidates);
  }

  function parseObjectEntries(body) {
    const entries = [];
    const entryPattern = /["']?([\w.-]+)["']?\s*:\s*["']([^"']{1,120})["']/g;
    let match;
    while ((match = entryPattern.exec(body)) !== null) {
      entries.push([match[1], match[2]]);
    }
    return entries;
  }

  function captureJsSuffix(text) {
    const match = text.match(/\+\s*["']([^"']*\.js[^"']*)["']/);
    return match ? decodeJsString(match[1]) : "";
  }

  function captureJsPrefix(text) {
    const match = text.match(/["']([^"']{0,80})["']\s*\+\s*$/);
    return match ? decodeJsString(match[1]) : "";
  }

  function extractApis(source, sourceUrl) {
    const results = [];
    const decoded = decodeEscapedSource(source);

    const patterns = [
      {
        name: "fetch",
        regex: /\bfetch\s*\(\s*["'`]([^"'`]{1,260})["'`]\s*(?:,\s*\{([\s\S]{0,240}?)\})?/g,
        methodFrom: 2
      },
      {
        name: "axios-method",
        regex: /\b(?:axios|request|http|service|\$http|this\.\$http)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*["'`]([^"'`]{1,260})["'`]/gi,
        methodIndex: 1,
        urlIndex: 2
      },
      {
        name: "axios-config",
        regex: /\b(?:axios|request|http|service)\s*\(\s*\{([\s\S]{0,700}?)\}\s*\)/g,
        configIndex: 1
      },
      {
        name: "url-property",
        regex: /\b(?:url|path|api|endpoint)\s*:\s*["'`]([^"'`]{1,260})["'`]/gi,
        urlIndex: 1
      },
      {
        name: "absolute-url",
        regex: /["'`](https?:\/\/[^"'`<>\s()]{3,260})["'`]/gi,
        urlIndex: 1
      },
      {
        name: "relative-api",
        regex: /["'`]((?:\/|\.\.?\/)[^"'`<>\s()]{1,260})["'`]/g,
        urlIndex: 1
      }
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.regex.exec(decoded)) !== null) {
        if (pattern.configIndex) {
          const config = match[pattern.configIndex];
          const url = readConfigValue(config, "url") || readConfigValue(config, "path") || readConfigValue(config, "baseURL");
          if (!url) {
            continue;
          }
          const method = readConfigValue(config, "method") || "ANY";
          pushApi(results, url, method, pattern.name, sourceUrl);
          continue;
        }

        const url = match[pattern.urlIndex || 1];
        const method = pattern.methodIndex ? match[pattern.methodIndex] : readMethod(match[pattern.methodFrom || 0] || "") || "ANY";
        pushApi(results, url, method, pattern.name, sourceUrl);
      }
    }

    return dedupeApis(results);
  }

  function pushApi(results, rawUrl, method, sourceType, sourceUrl) {
    const cleaned = cleanUrl(rawUrl);
    if (!cleaned || !looksLikeApi(cleaned)) {
      return;
    }

    results.push({
      method: normalizeMethod(method),
      url: cleaned,
      absoluteUrl: absolutize(cleaned, location.href) || "",
      source: sourceUrl,
      sourceType
    });
  }

  function readConfigValue(config, key) {
    const pattern = new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]{1,260})["'\`]`, "i");
    const match = config.match(pattern);
    return match ? match[1] : "";
  }

  function readMethod(text) {
    const match = text.match(/\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i);
    return match ? match[1] : "";
  }

  function normalizeMethod(method) {
    const upper = String(method || "ANY").toUpperCase();
    return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)$/.test(upper) ? upper : "ANY";
  }

  function dedupeApis(items) {
    const urlsWithMethod = new Set(
      items
        .filter((item) => item.method && item.method !== "ANY")
        .map((item) => item.url)
    );
    const seen = new Set();
    return items.filter((item) => {
      if (item.method === "ANY" && urlsWithMethod.has(item.url)) {
        return false;
      }
      const key = `${item.method} ${item.url}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function looksLikeApi(url) {
    if (!url || url.length < 2 || STATIC_EXTENSIONS.test(url)) {
      return false;
    }
    if (/^(?:data|blob|mailto|tel|javascript):/i.test(url)) {
      return false;
    }
    if (/^https?:\/\//i.test(url)) {
      return !STATIC_EXTENSIONS.test(new URL(url).pathname);
    }
    return API_HINT.test(url) || /\?.*=/.test(url);
  }

  function extractFindings(source, sourceUrl) {
    const decoded = decodeEscapedSource(source);
    const rules = [
      { type: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g },
      { type: "internal-ip", regex: /\b(?:127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g },
      { type: "swagger", regex: /\b(?:swagger-ui\.html|openapi\.json|api-docs|Swagger UI)\b/gi },
      { type: "sensitive-keyword", regex: /\b(?:access_key|accessKey|secretKey|client_secret|authorization|bearer\s+[A-Za-z0-9._-]{8,})\b/gi }
    ];

    const findings = [];
    for (const rule of rules) {
      let match;
      while ((match = rule.regex.exec(decoded)) !== null) {
        findings.push({
          type: rule.type,
          value: match[0].slice(0, 180),
          source: sourceUrl
        });
      }
    }
    return findings;
  }

  function injectExternalScript(url) {
    window.postMessage({
      source: "webpack-api-loader",
      type: "inject-script",
      payload: { url }
    }, "*");

    const script = document.createElement("script");
    script.src = url;
    script.async = false;
    script.dataset.webpackApiLoader = "true";
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function injectProbe() {
    try {
      const probeRequest = chrome.runtime.sendMessage({
        target: "background",
        action: "injectProbe"
      });
      if (probeRequest && typeof probeRequest.catch === "function") {
        probeRequest.catch(() => {});
      }
    } catch {
      // DOM injection below is the fallback for browsers without promise APIs.
    }

    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("pageProbe.js");
    script.async = false;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function waitForProbe() {
    if (state.probe) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, 350));
  }

  function clearState() {
    state.running = false;
    state.startedAt = null;
    state.finishedAt = null;
    state.pageUrl = location.href;
    state.pageTitle = document.title;
    state.scripts.clear();
    state.chunks.clear();
    state.apis.clear();
    state.findings.clear();
    state.logs = [];
    collectInitialScripts();
  }

  function serializeState() {
    return {
      running: state.running,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      pageUrl: state.pageUrl,
      pageTitle: state.pageTitle,
      scripts: Array.from(state.scripts.values()),
      chunks: Array.from(state.chunks.values()),
      apis: Array.from(state.apis.values()).sort((a, b) => a.url.localeCompare(b.url)),
      findings: Array.from(state.findings.values()).sort((a, b) => a.type.localeCompare(b.type)),
      probe: state.probe,
      logs: state.logs.slice(-120),
      summary: {
        scriptTags: state.scripts.size,
        chunks: state.chunks.size,
        loadedChunks: Array.from(state.chunks.values()).filter((item) => item.status === "loaded").length,
        failedChunks: Array.from(state.chunks.values()).filter((item) => item.status === "error").length,
        apis: state.apis.size,
        findings: state.findings.size
      }
    };
  }

  function buildExport() {
    return {
      tool: "Webpack API Loader",
      exportedAt: new Date().toISOString(),
      state: serializeState()
    };
  }

  function log(message, level = "info") {
    state.logs.push({
      level,
      message,
      time: new Date().toISOString()
    });
  }

  function absolutizeAsset(raw, baseUrl, publicPaths) {
    if (!raw) {
      return "";
    }
    if (/^(?:https?:)?\/\//i.test(raw) || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
      return absolutize(raw, baseUrl);
    }
    for (const publicPath of publicPaths) {
      const url = absolutize(raw, publicPath);
      if (url) {
        return url;
      }
    }
    return absolutize(raw, dirname(baseUrl));
  }

  function absolutize(raw, baseUrl) {
    try {
      if (!raw || /\$\{|\+/.test(raw)) {
        return "";
      }
      return new URL(raw, baseUrl || location.href).href;
    } catch {
      return "";
    }
  }

  function dirname(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = "";
      parsed.search = "";
      parsed.pathname = parsed.pathname.replace(/\/[^/]*$/, "/");
      return parsed.href;
    } catch {
      return location.origin + "/";
    }
  }

  function ensureTrailingSlash(url) {
    return url.endsWith("/") ? url : `${url}/`;
  }

  function stripHash(url) {
    return String(url).replace(/#.*$/, "");
  }

  function cleanUrl(raw) {
    return decodeJsString(String(raw || ""))
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .trim()
      .replace(/^["'`]|["'`]$/g, "");
  }

  function decodeJsString(value) {
    return String(value || "")
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/");
  }

  function decodeEscapedSource(source) {
    return decodeJsString(source).replace(/\\n|\\r|\\t/g, " ");
  }
})();
