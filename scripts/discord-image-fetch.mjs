const imageHosts = new Set([
  'raw.githubusercontent.com', 'github.com', 'cdn.jsdelivr.net', 'static.wikia.nocookie.net',
  'i.ibb.co', 'encrypted-tbn0.gstatic.com', 'pbs.twimg.com',
]);
const maxImageBytes = 8 * 1024 * 1024;

function approvedUrl(value) {
  if (typeof value !== 'string' || value.includes('#')) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443') && imageHosts.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

function cancelStream(stream) {
  try {
    void stream?.cancel().catch(() => {});
  } catch {
    // Cancellation must not turn an unavailable preview into a failed notification.
  }
}

async function readImage(response, signal) {
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const declaredLength = response.headers.get('content-length');
  if (!response.ok || !/^image\/[a-z0-9!#$&^_.+-]+$/.test(type) || type.includes('svg')
      || (declaredLength && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(maxImageBytes))
      || !response.body) {
    cancelStream(response.body);
    return null;
  }
  const reader = response.body.getReader();
  const abortReading = () => cancelStream(reader);
  signal.addEventListener('abort', abortReading, { once: true });
  let ended = false;
  try {
    let image = Buffer.allocUnsafe(8192);
    let length = 0;
    while (true) {
      if (signal.aborted) return null;
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      if (!(value instanceof Uint8Array) || value.byteLength > maxImageBytes - length) return null;
      const needed = length + value.byteLength;
      if (needed > image.length) {
        const grown = Buffer.allocUnsafe(Math.min(maxImageBytes, Math.max(needed, image.length * 2)));
        image.copy(grown, 0, 0, length);
        image = grown;
      }
      image.set(value, length);
      length = needed;
    }
    if (!length) return null;
    // Detect mislabeled XML/SVG before a downstream decoder can resolve its external assets.
    const bytes = image.subarray(0, length);
    if (/<(?:[a-z_][\w.-]*:)?svg[\s/>]/i.test(bytes.toString('utf8').replaceAll('\0', ''))) return null;
    return Buffer.from(bytes);
  } finally {
    signal.removeEventListener('abort', abortReading);
    if (!ended) cancelStream(reader);
    reader.releaseLock();
  }
}

export async function loadPreviewImage(url, { fetchImpl = globalThis.fetch } = {}) {
  let currentUrl = approvedUrl(url);
  if (!currentUrl) return null;
  const controller = new AbortController();
  const expired = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
  });
  const timeout = setTimeout(() => controller.abort(new Error('Preview image deadline exceeded')), 10000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await Promise.race([
        fetchImpl(currentUrl, { redirect: 'manual', credentials: 'omit', signal: controller.signal }), expired,
      ]);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        cancelStream(response.body);
        const location = response.headers.get('location');
        if (redirects === 3 || !location || location.includes('#')) return null;
        currentUrl = approvedUrl(new URL(location, currentUrl).href);
        if (!currentUrl) return null;
        continue;
      }
      return await Promise.race([readImage(response, controller.signal), expired]);
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
  return null;
}
