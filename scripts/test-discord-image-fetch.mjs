import assert from 'node:assert/strict';
import { test } from 'node:test';

let downloader = {};
try {
  downloader = await import('./discord-image-fetch.mjs');
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('discord-image-fetch.mjs')) throw error;
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const catalogHosts = ['raw.githubusercontent.com', 'github.com', 'cdn.jsdelivr.net', 'static.wikia.nocookie.net', 'i.ibb.co', 'encrypted-tbn0.gstatic.com', 'pbs.twimg.com'];

// Catches dropped catalog hosts, altered image bytes, or automatic redirects that bypass validation.
test('returns the image bytes from each approved catalog host using a manually redirected HTTPS request', async () => {
  assert.equal(typeof downloader.loadPreviewImage, 'function', 'The bounded image downloader must be available');
  for (const host of catalogHosts) {
    const url = `https://${host}/preview.png`;
    const image = await downloader.loadPreviewImage(url, { fetchImpl: async (actualUrl, options) => {
      assert.equal(String(actualUrl), url);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    } });
    assert.deepEqual(image, png);
  }
});

// Catches URL validation that sends credentials, HTTP requests, private addresses, or lookalike hosts to fetch.
test('rejects unsafe or unauthorized URLs before issuing a request', async () => {
  const blocked = [
    'http://raw.githubusercontent.com/preview.png',
    'ftp://github.com/preview.png',
    'data:image/png;base64,AAAA',
    'https://127.0.0.1/preview.png',
    'https://10.1.2.3/preview.png',
    'https://169.254.169.254/preview.png',
    'https://[::1]/preview.png',
    'https://[fc00::1]/preview.png',
    'https://localhost/preview.png',
    'https://raw.githubusercontent.com.evil.example/preview.png',
    'https://sub.raw.githubusercontent.com/preview.png',
    'https://raw.githubusercontent.com./preview.png',
    'https://token@raw.githubusercontent.com/preview.png',
    'https://user:secret@github.com/preview.png',
    'https://raw.githubusercontent.com:444/preview.png',
    'https://raw.githubusercontent.com/preview.png#token',
    'https://raw.githubusercontent.com/preview.png#',
    'https://raw.githubusercontent.com@127.0.0.1/preview.png',
    'https://example.org/preview.png',
    'not a URL', null, undefined, {},
  ];
  for (const url of blocked) {
    let fetched = false;
    const result = await downloader.loadPreviewImage(url, { fetchImpl: async () => {
      fetched = true;
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    } });
    assert.equal(result, null, `Unsafe URL should be rejected: ${String(url)}`);
    assert.equal(fetched, false, 'A rejected URL must never reach the network boundary');
  }
});

// Catches disabled manual redirects, unresolved relative URLs, or a missing GitHub-to-raw path.
test('follows an approved GitHub redirect and relative redirects up to three hops', async () => {
  const responses = new Map([
    ['https://github.com/owner/repo/blob/main/image.png', new Response(null, { status: 302, headers: { location: 'https://raw.githubusercontent.com/owner/repo/main/image.png' } })],
    ['https://raw.githubusercontent.com/owner/repo/main/image.png', new Response(null, { status: 307, headers: { location: './second.png' } })],
    ['https://raw.githubusercontent.com/owner/repo/main/second.png', new Response(null, { status: 308, headers: { location: '/final.png' } })],
    ['https://raw.githubusercontent.com/final.png', new Response(png, { headers: { 'content-type': 'image/png' } })],
  ]);
  const visited = [];
  const image = await downloader.loadPreviewImage('https://github.com/owner/repo/blob/main/image.png', { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual');
    visited.push(String(url));
    assert.ok(responses.has(String(url)), 'Only the declared redirect chain can be fetched');
    return responses.get(String(url));
  } });
  assert.deepEqual(image, png);
  assert.deepEqual(visited, [
    'https://github.com/owner/repo/blob/main/image.png',
    'https://raw.githubusercontent.com/owner/repo/main/image.png',
    'https://raw.githubusercontent.com/owner/repo/main/second.png',
    'https://raw.githubusercontent.com/final.png',
  ]);
});

// Catches redirect validation that permits a forbidden destination or attempts a fourth redirect.
test('rejects unsafe redirect destinations and refuses to follow more than three redirects', async () => {
  const blocked = [
    'http://raw.githubusercontent.com/image.png',
    'https://127.0.0.1/image.png',
    'https://token@raw.githubusercontent.com/image.png',
    'https://user:secret@github.com/image.png',
    'https://raw.githubusercontent.com:444/image.png',
    'https://raw.githubusercontent.com/image.png#token',
    'https://raw.githubusercontent.com/image.png#',
    'https://example.org/image.png',
    'https://raw.githubusercontent.com.evil.example/image.png',
    'https://[invalid', '',
  ];
  for (const location of blocked) {
    let requests = 0;
    const result = await downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async url => {
      requests++;
      assert.equal(String(url), 'https://github.com/image.png');
      return new Response(null, { status: 301, headers: { location } });
    } });
    assert.equal(result, null, `Unsafe redirect should be rejected: ${location}`);
    assert.equal(requests, 1, 'A rejected redirect destination must never reach the network boundary');
  }
  let requests = 0;
  const tooMany = await downloader.loadPreviewImage('https://github.com/0.png', { fetchImpl: async url => {
    assert.equal(String(url), `https://github.com/${requests}.png`);
    requests++;
    return new Response(null, { status: 303, headers: { location: `/${requests}.png` } });
  } });
  assert.equal(tooMany, null);
  assert.equal(requests, 4, 'Three redirects allow four responses, never a fifth request');
});

// Catches rejection/error paths that throw into the Discord notification flow.
test('returns null for a missing redirect location or a failed request', async () => {
  assert.equal(await downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async () => new Response(null, { status: 302 }) }), null);
  assert.equal(await downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async () => { throw new Error('Fixture transport failure'); } }), null);
});

// Catches trusting successful status alone or handing a remote SVG to an image decoder.
test('rejects failed responses, non-image MIME types, and remote SVG MIME types', async () => {
  const cases = [
    { status: 404, type: 'image/png' },
    { status: 500, type: 'image/png' },
    { status: 200, type: '' },
    { status: 200, type: 'text/html' },
    { status: 200, type: 'application/octet-stream' },
    { status: 200, type: 'image/' },
    { status: 200, type: 'image/svg+xml' },
    { status: 200, type: 'IMAGE/SVG+XML; charset=utf-8' },
    { status: 200, type: 'image/x-svg+xml' },
  ];
  for (const { status, type } of cases) {
    const result = await downloader.loadPreviewImage('https://raw.githubusercontent.com/image', {
      fetchImpl: async () => new Response(png, { status, headers: { 'content-type': type } }),
    });
    assert.equal(result, null, `Reject status ${status} and type ${type}`);
  }
  const accepted = await downloader.loadPreviewImage('https://raw.githubusercontent.com/image', {
    fetchImpl: async () => new Response(png, { headers: { 'content-type': 'IMAGE/PNG; charset=binary' } }),
  });
  assert.deepEqual(accepted, png);
});

// Catches SVGs disguised as raster data, including XML prologs, padding, and UTF-16 payloads.
test('rejects an SVG body even when its content type claims it is a PNG', async () => {
  for (const body of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.org/private"/></svg>'),
    Buffer.from(`<?xml version="1.0"?>${' '.repeat(5000)}<SVG xmlns="http://www.w3.org/2000/svg"/>`),
    Buffer.from('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>', 'utf16le'),
  ]) {
    const result = await downloader.loadPreviewImage('https://raw.githubusercontent.com/image.png', {
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/png' } }),
    });
    assert.equal(result, null);
  }
});

// Catches trusting an understated Content-Length or buffering an overflowing stream to its end.
test('cancels an overflowing stream after the first chunk beyond eight MiB', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(7);
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(chunk);
      if (pulls === 12) controller.close();
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await downloader.loadPreviewImage('https://cdn.jsdelivr.net/image.png', {
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/png', 'content-length': '1' } }),
  });
  assert.ok(result === null, 'The overflowing image must be rejected');
  assert.equal(pulls, 9, 'The downloader must stop before reading any remaining oversized input');
  assert.equal(cancelled, true, 'The overflowing response must be cancelled');
});

// Catches an off-by-one cap or lossy assembly of a multi-chunk response.
test('accepts exactly eight MiB and returns all streamed chunks in order', async () => {
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      pulls++;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(pulls));
      if (pulls === 8) controller.close();
    },
  }, { highWaterMark: 0 });
  const result = await downloader.loadPreviewImage('https://cdn.jsdelivr.net/image.png', {
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/png' } }),
  });
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.length, 8 * 1024 * 1024);
  for (let chunk = 0; chunk < 8; chunk++) {
    assert.equal(result[chunk * 1024 * 1024], chunk + 1);
    assert.equal(result[(chunk + 1) * 1024 * 1024 - 1], chunk + 1);
  }
});

// Catches reading an advertised oversized body or accepting an empty image.
test('rejects an advertised oversized body before reading it and rejects empty image bodies', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const result = await downloader.loadPreviewImage('https://cdn.jsdelivr.net/image.png', {
    fetchImpl: async () => new Response(body, { headers: { 'content-type': 'image/png', 'content-length': '8388609' } }),
  });
  assert.equal(result, null);
  assert.equal(pulls, 0);
  assert.equal(cancelled, true);
  assert.equal(await downloader.loadPreviewImage('https://cdn.jsdelivr.net/image.png', {
    fetchImpl: async () => new Response(null, { headers: { 'content-type': 'image/png' } }),
  }), null);
});

// Catches unclosed redirect and rejected MIME responses that retain their remote streams.
test('cancels response bodies before following redirects or rejecting a MIME type', async () => {
  for (const headers of [{ location: 'https://raw.githubusercontent.com/image.png' }, { 'content-type': 'text/html' }]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.close(); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    let requests = 0;
    const result = await downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async url => {
      requests++;
      if (requests === 1) return new Response(body, { status: headers.location ? 302 : 200, headers });
      assert.equal(String(url), 'https://raw.githubusercontent.com/image.png');
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    } });
    assert.equal(cancelled, true);
    assert.deepEqual(result, headers.location ? png : null);
  }
});

// Catches a missing deadline or a fetch implementation that ignores the supplied abort signal.
test('aborts a stalled request at ten seconds and returns null', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const pending = downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true, 'A stalled network request must receive the ten-second abort');
  assert.equal(await pending, null);
});

// Catches deadlines that expire only during fetch, allowing a stalled image body to hold the workflow open.
test('applies the same deadline to a stalled response stream and cancels the stream', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const reading = new Promise(resolve => { started = resolve; });
  let signal;
  let cancelled = false;
  const body = new ReadableStream({
    pull() { started(); return new Promise(() => {}); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const pending = downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(body, { headers: { 'content-type': 'image/png' } });
  } });
  await reading;
  t.mock.timers.tick(10000);
  assert.equal(signal.aborted, true, 'Reading the body must retain the request deadline');
  assert.equal(await pending, null);
  assert.equal(cancelled, true);
});

// Catches resetting the timeout per redirect, which lets redirect chains exceed the total deadline.
test('keeps one ten-second deadline across redirects', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let redirected;
  const secondRequest = new Promise(resolve => { redirected = resolve; });
  let signal;
  const pending = downloader.loadPreviewImage('https://github.com/image.png', { fetchImpl: async (url, options) => {
    signal = options.signal;
    if (String(url) === 'https://github.com/image.png') {
      await new Promise(resolve => setTimeout(resolve, 6000));
      return new Response(null, { status: 302, headers: { location: 'https://raw.githubusercontent.com/image.png' } });
    }
    assert.equal(String(url), 'https://raw.githubusercontent.com/image.png');
    redirected();
    return new Promise(() => {});
  } });
  t.mock.timers.tick(6000);
  await secondRequest;
  t.mock.timers.tick(3999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true, 'The redirect must not reset the total request deadline');
  assert.equal(await pending, null);
});
