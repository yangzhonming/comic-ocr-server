// Comic Translate - Background Service Worker (Manifest V3)
// Acts as a privileged network bridge for local loopback (127.0.0.1:8080)
// to bypass browser Mixed Content (HTTPS -> HTTP) and PNA restrictions.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ComicBackground] Service Worker installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === 'OCR_FETCH') {
    handleOcrFetch(message)
      .then(result => sendResponse(result))
      .catch(err => {
        console.error('[ComicBackground] OCR fetch error:', err);
        sendResponse({
          ok: false,
          status: 0,
          error: err.message || String(err)
        });
      });
    return true; // Keep message channel open for async response
  }
});

async function handleOcrFetch(req) {
  const { url, method = 'GET', isFormData = false, fields = {}, file = null, jsonBody = null, headers = {} } = req;

  let fetchOptions = {
    method,
    headers: { ...headers }
  };

  if (isFormData) {
    const formData = new FormData();
    for (const [key, val] of Object.entries(fields)) {
      formData.append(key, val);
    }
    if (file) {
      let blob = null;
      if (file.base64) {
        let b64 = file.base64;
        if (b64.includes(',')) b64 = b64.substring(b64.indexOf(',') + 1);
        const binaryStr = atob(b64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        blob = new Blob([bytes], { type: file.type || 'image/jpeg' });
      } else if (file.data) {
        blob = new Blob([file.data], { type: file.type || 'image/jpeg' });
      }
      if (blob) {
        formData.append('file', blob, file.name || 'slice.jpg');
      }
    }
    fetchOptions.body = formData;
  } else if (jsonBody) {
    fetchOptions.headers['Content-Type'] = 'application/json';
    fetchOptions.body = typeof jsonBody === 'string' ? jsonBody : JSON.stringify(jsonBody);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Background fetch timed out after 20s'));
  }, 20000);
  fetchOptions.signal = controller.signal;

  try {
    const res = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);
    const contentType = res.headers.get('content-type') || '';
    let data = null;
    let text = '';

    if (contentType.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      text = await res.text().catch(() => '');
    }

    return {
      ok: res.ok,
      status: res.status,
      data,
      text
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      ok: false,
      status: 0,
      error: err.message || String(err)
    };
  }
}
