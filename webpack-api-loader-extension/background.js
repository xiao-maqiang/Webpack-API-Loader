const DEFAULT_TIMEOUT_MS = 30000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "background") {
    return false;
  }

  if (message.action === "fetchText") {
    fetchText(message.url, message.timeout || DEFAULT_TIMEOUT_MS)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          ok: false,
          status: 0,
          url: message.url,
          error: error.message || String(error)
        });
      });
    return true;
  }

  if (message.action === "downloadJson") {
    downloadJson(message.filename, message.payload)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  if (message.action === "injectProbe" && sender.tab && sender.tab.id) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      files: ["pageProbe.js"],
      world: "MAIN"
    }).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  return false;
});

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "include",
      redirect: "follow",
      signal: controller.signal
    });

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      url: response.url || url,
      text
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadJson(filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(json)}`;
  const id = await chrome.downloads.download({
    url: dataUrl,
    filename: filename || "webpack-api-loader-results.json",
    saveAs: true
  });
  return { ok: true, id };
}
