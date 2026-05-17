let activeTab = "apis";
let latestState = null;
let activeTabId = null;

const elements = {
  pageLabel: document.getElementById("pageLabel"),
  statusBadge: document.getElementById("statusBadge"),
  scanBtn: document.getElementById("scanBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  clearBtn: document.getElementById("clearBtn"),
  copyBtn: document.getElementById("copyBtn"),
  copyPureBtn: document.getElementById("copyPureBtn"),
  exportBtn: document.getElementById("exportBtn"),
  depthSelect: document.getElementById("depthSelect"),
  sourceMapToggle: document.getElementById("sourceMapToggle"),
  injectToggle: document.getElementById("injectToggle"),
  chunkCount: document.getElementById("chunkCount"),
  loadedCount: document.getElementById("loadedCount"),
  apiCount: document.getElementById("apiCount"),
  findingCount: document.getElementById("findingCount"),
  panel: document.getElementById("panel")
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab && tab.id;

  bindEvents();
  await refresh();

  setInterval(() => {
    if (latestState && latestState.running) {
      refresh();
    }
  }, 1200);
}

function bindEvents() {
  elements.scanBtn.addEventListener("click", scan);
  elements.refreshBtn.addEventListener("click", refresh);
  elements.clearBtn.addEventListener("click", clearResults);
  elements.copyBtn.addEventListener("click", copyApis);
  elements.copyPureBtn.addEventListener("click", copyPureApis);
  elements.exportBtn.addEventListener("click", exportJson);

  for (const tabButton of document.querySelectorAll(".tab")) {
    tabButton.addEventListener("click", () => {
      activeTab = tabButton.dataset.tab;
      document.querySelectorAll(".tab").forEach((button) => {
        button.classList.toggle("active", button === tabButton);
      });
      render();
    });
  }
}

async function scan() {
  setBusy(true);
  const options = {
    maxDepth: Number(elements.depthSelect.value),
    includeSourceMaps: elements.sourceMapToggle.checked,
    injectScripts: elements.injectToggle.checked,
    maxScripts: 300
  };

  const response = await sendToContent({ action: "scan", options });
  if (response && response.state) {
    latestState = response.state;
  }
  setBusy(false);
  render();
}

async function refresh() {
  const response = await sendToContent({ action: "getState" });
  if (response && response.state) {
    latestState = response.state;
  }
  render();
}

async function clearResults() {
  const response = await sendToContent({ action: "clear" });
  if (response && response.state) {
    latestState = response.state;
  }
  render();
}

async function copyApis() {
  if (!latestState || !latestState.apis.length) {
    setBadge("No APIs");
    return;
  }

  const text = latestState.apis
    .map((api) => `${api.method || "ANY"} ${api.url}`)
    .join("\n");
  await navigator.clipboard.writeText(text);
  setBadge("Copied");
}

async function copyPureApis() {
  const urls = getUniqueApiUrls();
  if (!urls.length) {
    setBadge("No APIs");
    return;
  }

  await navigator.clipboard.writeText(urls.join("\n"));
  setBadge("Pure copied");
}

async function exportJson() {
  const response = await sendToContent({ action: "export" });
  const payload = response && response.export ? response.export : { state: latestState };
  const host = safeFilename(new URL((latestState && latestState.pageUrl) || "https://target.local").hostname);
  const filename = `webpack-api-loader-${host}-${new Date().toISOString().slice(0, 10)}.json`;

  const download = await chrome.runtime.sendMessage({
    target: "background",
    action: "downloadJson",
    filename,
    payload
  });

  setBadge(download && download.ok ? "Exported" : "Export failed");
}

async function sendToContent(message) {
  if (!activeTabId) {
    setBadge("No tab");
    return null;
  }

  try {
    return await chrome.tabs.sendMessage(activeTabId, {
      target: "content",
      ...message
    });
  } catch (error) {
    elements.panel.innerHTML = `<div class="empty">当前页面还没有注入 content script。刷新页面后再打开插件。</div>`;
    setBadge("Need refresh");
    return null;
  }
}

function render() {
  if (!latestState) {
    elements.panel.innerHTML = `<div class="empty">打开目标页面后点击扫描。</div>`;
    return;
  }

  elements.pageLabel.textContent = latestState.pageTitle || latestState.pageUrl || "当前页面";
  elements.chunkCount.textContent = latestState.summary.chunks;
  elements.loadedCount.textContent = latestState.summary.loadedChunks;
  elements.apiCount.textContent = latestState.summary.apis;
  elements.findingCount.textContent = latestState.summary.findings;
  setBadge(latestState.running ? "Scanning" : "Ready", latestState.running);

  if (activeTab === "apis") {
    renderApis();
  } else if (activeTab === "chunks") {
    renderChunks();
  } else if (activeTab === "findings") {
    renderFindings();
  } else {
    renderLogs();
  }
}

function renderApis() {
  const apis = latestState.apis || [];
  if (!apis.length) {
    elements.panel.innerHTML = `<div class="empty">还没有发现接口，先扫描当前页面的 JS 包。</div>`;
    return;
  }

  elements.panel.innerHTML = apis.map((api) => `
    <article class="row">
      <div class="meta">
        <span class="method">${escapeHtml(api.method || "ANY")}</span>
        <span>${escapeHtml(api.sourceType || "regex")}</span>
        <span>${api.count || 1}x</span>
      </div>
      <code>${escapeHtml(api.url)}</code>
    </article>
  `).join("");
}

function renderChunks() {
  const chunks = latestState.chunks || [];
  if (!chunks.length) {
    elements.panel.innerHTML = `<div class="empty">还没有发现 JS 分包。</div>`;
    return;
  }

  elements.panel.innerHTML = chunks.map((chunk) => `
    <article class="row">
      <div class="meta">
        <span class="status-${escapeHtml(chunk.status || "queued")}">${escapeHtml(chunk.status || "queued")}</span>
        <span>depth ${escapeHtml(String(chunk.depth || 0))}</span>
        <span>${chunk.bytes ? formatBytes(chunk.bytes) : ""}</span>
      </div>
      <code>${escapeHtml(chunk.url)}</code>
      ${chunk.error ? `<span class="meta status-error">${escapeHtml(chunk.error)}</span>` : ""}
    </article>
  `).join("");
}

function renderFindings() {
  const findings = latestState.findings || [];
  if (!findings.length) {
    elements.panel.innerHTML = `<div class="empty">还没有发现敏感线索。</div>`;
    return;
  }

  elements.panel.innerHTML = findings.map((finding) => `
    <article class="row">
      <div class="meta">
        <span class="method">${escapeHtml(finding.type)}</span>
        <span>${finding.count || 1}x</span>
      </div>
      <code>${escapeHtml(finding.value)}</code>
    </article>
  `).join("");
}

function renderLogs() {
  const logs = latestState.logs || [];
  if (!logs.length) {
    elements.panel.innerHTML = `<div class="empty">暂无日志。</div>`;
    return;
  }

  elements.panel.innerHTML = logs.slice().reverse().map((log) => `
    <article class="row">
      <div class="meta">
        <span>${escapeHtml(log.level)}</span>
        <span>${escapeHtml(new Date(log.time).toLocaleTimeString())}</span>
      </div>
      <code>${escapeHtml(log.message)}</code>
    </article>
  `).join("");
}

function setBusy(isBusy) {
  elements.scanBtn.disabled = isBusy;
  elements.refreshBtn.disabled = isBusy;
  elements.clearBtn.disabled = isBusy;
  setBadge(isBusy ? "Scanning" : "Ready", isBusy);
}

function setBadge(text, running = false) {
  elements.statusBadge.textContent = text;
  elements.statusBadge.classList.toggle("running", running);
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function getUniqueApiUrls() {
  if (!latestState || !Array.isArray(latestState.apis)) {
    return [];
  }

  const seen = new Set();
  const urls = [];
  for (const api of latestState.apis) {
    const url = String(api.url || "").trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function safeFilename(value) {
  return String(value || "target").replace(/[^a-z0-9.-]+/gi, "_");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
