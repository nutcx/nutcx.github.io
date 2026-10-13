import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createCatalogSnapshot, diffCatalogSnapshots, buildDiscordBatches } from './discord-content-diff.mjs';

const publicKeys = { 'nutcx-content-2026-01': 'MCowBQYDK2VwAyEA/nqv5THRQyePGH/ARBmY+hzQygbVq34lhQXzf/YmYpk=' };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

function validateSnapshot(snapshot) {
  requireValue(snapshot?.schemaVersion === 1 && /^\d+$/.test(snapshot.sequence)
    && BigInt(snapshot.sequence) > 0n && /^\d+\.\d+$/.test(snapshot.version)
    && /^[a-f0-9]{64}$/.test(snapshot.contentSha256) && Array.isArray(snapshot.routes), 'Invalid notification snapshot.');
  for (const route of snapshot.routes) {
    requireValue(['pairKey', 'targetKey', 'kind', 'group', 'name', 'image', 'sourceName', 'sourceImage', 'sourceKey', 'path', 'fingerprint']
      .every(key => typeof route[key] === 'string') && /^[a-f0-9]{64}$/.test(route.fingerprint)
      && /^\/(?:heroes|preparations)\//.test(route.path), 'Invalid notification snapshot route.');
  }
}
function validateState(state) {
  requireValue(state?.schemaVersion === 1 && ['complete', 'pending'].includes(state.status)
    && Array.isArray(state.receipts), 'Invalid notification state.');
  validateSnapshot(state.snapshot);
  if (state.status === 'pending') validateSnapshot(state.candidate);
}
const complete = (snapshot, receipts = []) => ({ schemaVersion: 1, status: 'complete', snapshot, receipts });

/** Pure planner: no network, no secret, and no automatic replay of uncertain sends. */
export function planPublication(previousState, current, { recovery = 'none' } = {}) {
  validateSnapshot(current);
  if (!previousState) return { mode: 'seed', state: complete(current), changes: [], batches: [] };
  validateState(previousState);
  let recovered = false;
  if (previousState.status === 'pending') {
    requireValue(recovery === 'skip-interrupted',
      'An interrupted Discord announcement needs review. Check the channel before using skip-interrupted recovery.');
    previousState = complete(previousState.candidate, previousState.receipts);
    recovered = true;
  }
  const prior = previousState.snapshot;
  requireValue(BigInt(current.sequence) >= BigInt(prior.sequence), 'Notification publication rollback rejected.');
  if (current.sequence === prior.sequence) {
    requireValue(current.contentSha256 === prior.contentSha256, 'Notification publication sequence collision.');
    return { mode: recovered ? 'advance' : 'skip', state: previousState, changes: [], batches: [] };
  }
  const changes = diffCatalogSnapshots(prior, current);
  if (!changes.length) return { mode: 'advance', state: complete(current), changes, batches: [] };
  return {
    mode: 'send', changes,
    state: { schemaVersion: 1, status: 'pending', snapshot: prior, candidate: current, receipts: [] },
    batches: buildDiscordBatches(changes, { sequence: current.sequence, version: current.version }),
  };
}

/** Latest durable record, including a pending intent from a previous run attempt. */
export function selectStateArtifact(artifacts, { runId, attempt } = {}) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const match = /^discord-state-(intent|result)-(\d+)-(\d+)$/.exec(artifact.name);
    if (!match || artifact.expired || artifact.workflow_run?.head_branch !== 'main'
      || (match[2] === String(runId) && Number(match[3]) >= Number(attempt))) continue;
    const createdAt = Date.parse(artifact.created_at);
    requireValue(typeof artifact.created_at === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(artifact.created_at)
      && Number.isFinite(createdAt), 'Discord history has an invalid creation time; refusing to reset or replay.');
    const key = `${match[2]}-${match[3]}`;
    const group = groups.get(key) ?? { run: BigInt(match[2]), attempt: BigInt(match[3]), createdAt };
    group.createdAt = Math.max(group.createdAt, createdAt);
    const prior = group[match[1]];
    if (!prior || createdAt > prior.createdAt) group[match[1]] = { artifact, createdAt };
    groups.set(key, group);
  }
  // IDs are opaque: GitHub can assign an older intent a larger ID than its result.
  // Group first so a result supersedes only its matching intent, not a newer attempt.
  const compareDescending = (a, b) => a === b ? 0 : a > b ? -1 : 1;
  const latest = [...groups.values()].sort((a, b) => b.createdAt - a.createdAt
    || compareDescending(a.run, b.run) || compareDescending(a.attempt, b.attempt))[0];
  // A result may still contain pending state after a failed send; the planner checks it.
  return (latest?.result ?? latest?.intent)?.artifact ?? null;
}

function webhookEndpoint(value) {
  try {
    const url = new URL(value);
    requireValue(url.protocol === 'https:' && ['discord.com', 'discordapp.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash
      && /^\/api(?:\/v10)?\/webhooks\/\d+\/[\w.-]+$/.test(url.pathname), 'Invalid webhook.');
    const threadId = url.searchParams.get('thread_id');
    requireValue(threadId === null || /^\d+$/.test(threadId), 'Invalid webhook thread.');
    url.search = '';
    if (threadId) url.searchParams.set('thread_id', threadId);
    url.searchParams.set('wait', 'true');
    return url;
  } catch { throw new Error('Invalid Discord webhook configuration.'); }
}

/** One POST per message. A timeout is ambiguous, so never automatically retry it. */
export async function sendDiscordPlan(plan, { webhookUrl, intentRecorded = false,
  fetchImpl = globalThis.fetch, onProgress = async () => {},
  getAttachment = filename => plan.attachments?.find(attachment => attachment.filename === filename),
  wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds)) } = {}) {
  requireValue(intentRecorded && plan.mode === 'send' && plan.state.status === 'pending',
    'A durable notification intent must be recorded before sending.');
  requireValue(plan.state.receipts.length === 0, 'An interrupted notification cannot be replayed automatically.');
  const endpoint = webhookEndpoint(webhookUrl);
  for (const [batchIndex, batch] of plan.batches.entries()) {
    const form = new FormData();
    const files = await Promise.all((batch.embeds ?? []).map(embed => {
      const filename = embed.image?.url?.replace(/^attachment:\/\//, '');
      requireValue(/^comparison-\d+\.webp$/.test(filename), 'Invalid comparison attachment name.');
      return getAttachment(filename);
    }));
    requireValue(files.length <= 5 && files.every(file => file && Buffer.isBuffer(file.bytes)
      && file.bytes.length <= 1024 * 1024), 'Invalid comparison attachments.');
    const payload = { username: 'NutCracker Updates', ...batch,
      attachments: files.map((file, index) => ({ id: index, filename: file.filename })) };
    form.append('payload_json', JSON.stringify(payload));
    files.forEach((file, index) => form.append(`files[${index}]`, new Blob([file.bytes], { type: 'image/webp' }), file.filename));
    let response;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error('Discord confirmation was lost; announcement remains pending. Do not blindly retry.'); }
    requireValue(response.ok, `Discord announcement interrupted (HTTP ${response.status}); review before retrying.`);
    let receipt;
    try { receipt = await response.json(); } catch { /* No proven confirmation. */ }
    requireValue(receipt && /^\d+$/.test(receipt.id), 'Discord confirmation is invalid; announcement remains pending.');
    plan.state.receipts.push({ id: receipt.id, everyoneParsed: receipt.mention_everyone === true });
    await onProgress(plan.state);
    if (batchIndex < plan.batches.length - 1 && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = response.headers.get('x-ratelimit-reset-after');
      const seconds = Number(reset);
      requireValue(reset !== null && /^\d+(?:\.\d+)?$/.test(reset) && seconds <= 60,
        'Discord rate-limit window needs review; confirmed messages were preserved.');
      await wait(Math.ceil(seconds * 1000) + 50);
    }
  }
  const result = complete(plan.state.candidate, plan.state.receipts);
  await onProgress(result);
  return result;
}

async function output(values) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    else console.log(`${key}=${value}`);
  }
}
async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}
async function readJson(path) {
  const bytes = await readFile(path);
  requireValue(bytes.length <= 8 * 1024 * 1024, 'Notification state is too large.');
  return JSON.parse(bytes.toString('utf8'));
}
async function githubJson(path) {
  requireValue(process.env.GITHUB_TOKEN, 'GitHub Actions read token is missing.');
  const response = await fetch(`https://api.github.com${path}`, { headers: {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  requireValue(response.ok, `GitHub notification-state lookup failed (HTTP ${response.status}).`);
  return response.json();
}
async function locateState() {
  const repository = process.env.GITHUB_REPOSITORY;
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository), 'Invalid GitHub repository.');
  const artifacts = [];
  for (let page = 1; page <= 100; page++) {
    const data = await githubJson(`/repos/${repository}/actions/artifacts?per_page=100&page=${page}`);
    requireValue(Array.isArray(data.artifacts), 'Invalid artifact lookup response.');
    artifacts.push(...data.artifacts);
    if (data.artifacts.length < 100) break;
    requireValue(page < 100, 'Artifact lookup limit reached; refusing to reset notification history.');
  }
  let selected;
  while ((selected = selectStateArtifact(artifacts, { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT }))) {
    const run = await githubJson(`/repos/${repository}/actions/runs/${selected.workflow_run.id}`);
    if (run.path === '.github/workflows/pages.yml' && run.head_branch === 'main') break;
    artifacts.splice(artifacts.indexOf(selected), 1);
  }
  await output({ artifact_id: selected?.id ?? '', run_id: selected?.workflow_run.id ?? '' });
}

/** The website may still serve the previous deployment briefly. Never announce that candidate. */
async function requireLiveManifest(root) {
  const expected = sha256(await readFile(resolve(root, 'manifest.json')));
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`https://nutcx.github.io/content/manifest.json?notification=${expected}`, {
        headers: { 'cache-control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && sha256(Buffer.from(await response.arrayBuffer())) === expected) return;
    } catch { /* Deployment propagation is bounded; failure is handled below. */ }
    if (attempt < 5) await new Promise(resolveWait => setTimeout(resolveWait, 5_000));
  }
  throw new Error('The published manifest does not match this deployment. Discord was not notified.');
}

async function prepare(workDirectory, previousDirectory) {
  const { loadPublicContentDelivery } = await import('./public-content-manifest.mjs');
  const current = createCatalogSnapshot(await loadPublicContentDelivery(resolve('public/content'), { publicKeys }));
  // The stored artifact may have expired. A missing history always seeds silently.
  const previous = previousDirectory ? await readJson(resolve(previousDirectory, 'state.json')) : null;
  const recovery = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? process.env.DISCORD_RECOVERY : 'none';
  const plan = planPublication(previous, current, { recovery });
  await requireLiveManifest(resolve('public/content'));
  await mkdir(workDirectory, { recursive: true });
  if (plan.mode === 'send') {
    const { composeComparisonImage } = await import('./discord-comparison-image.mjs');
    const { loadPreviewImage } = await import('./discord-image-fetch.mjs');
    const cache = new Map();
    const loadImage = url => {
      if (!cache.has(url)) {
        // Keep large catalog publications bounded instead of retaining every image.
        if (cache.size >= 16) cache.delete(cache.keys().next().value);
        cache.set(url, loadPreviewImage(url));
      }
      return cache.get(url);
    };
    for (let index = 0; index < plan.changes.length; index++) {
      const change = plan.changes[index];
      const image = await composeComparisonImage({ originals: change.originals,
        replacement: { name: change.name, image: change.image } }, { loadImage });
      requireValue(image.length <= 1024 * 1024, 'Comparison preview exceeds the attachment budget.');
      await writeFile(resolve(workDirectory, `comparison-${index}.webp`), image);
    }
  }
  await saveJson(resolve(workDirectory, 'state.json'), plan.state);
  await saveJson(resolve(workDirectory, 'plan.json'), plan);
  console.log(`Discord plan: ${plan.mode}; ${plan.changes.length} changed targets; ${plan.batches.length} messages.`);
  await output({ mode: plan.mode });
}
async function send(workDirectory) {
  const plan = await readJson(resolve(workDirectory, 'plan.json'));
  const result = await sendDiscordPlan(plan, { webhookUrl: process.env.DISCORD_WEBHOOK_URL,
    intentRecorded: process.env.DISCORD_INTENT_RECORDED === 'true',
    getAttachment: async filename => ({ filename, bytes: await readFile(resolve(workDirectory, filename)) }),
    onProgress: state => saveJson(resolve(workDirectory, 'state.json'), state),
  });
  console.log(`Discord confirmed ${result.receipts.length} messages for publication ${result.snapshot.sequence}.`);
  if (result.receipts.length && !result.receipts[0].everyoneParsed)
    console.warn('Discord delivered the announcement, but @everyone was not parsed. Check the channel permissions.');
}
async function main() {
  const [command, workDirectory, previousDirectory] = process.argv.slice(2);
  if (command === 'locate') return locateState();
  requireValue(workDirectory, 'Usage: discord-content-notifier.mjs locate | prepare WORK_DIRECTORY [PREVIOUS_DIRECTORY] | send WORK_DIRECTORY');
  if (command === 'prepare') return prepare(resolve(workDirectory), previousDirectory);
  if (command === 'send') return send(resolve(workDirectory));
  throw new Error('Unknown Discord notification command.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Never print fetch errors, webhook URLs, tokens, or raw remote response bodies.
    const message = error.message?.startsWith('Discord') || error.message?.startsWith('An interrupted')
      || error.message?.startsWith('The published') ? error.message : 'Discord notification step failed; no secret details were logged.';
    console.error(message);
    process.exitCode = 1;
  });
}
