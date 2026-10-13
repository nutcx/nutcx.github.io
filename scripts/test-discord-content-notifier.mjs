import assert from 'node:assert/strict';
import { test } from 'node:test';

const notifier = await import('./discord-content-notifier.mjs').catch(() => ({}));
const snapshot = (sequence = '10', fingerprint = 'a'.repeat(64)) => ({
  schemaVersion: 1, sequence, version: '1001.14', contentSha256: (sequence === '10' ? 'b' : 'c').repeat(64),
  routes: [{ pairKey: 'skin:30:0:1301:0:1305', targetKey: 'skin:30:0:1305',
    kind: 'skin', group: 'Yi Sun-shin', name: 'Lone Destructor', image: '',
    sourceName: 'Paenlong Legend', sourceImage: '', sourceKey: 'skin:30:0:1301',
    path: '/heroes/30/1301-1305/', fingerprint }],
});
const completed = current => ({ schemaVersion: 1, status: 'complete', snapshot: current, receipts: [] });
const pending = () => ({ schemaVersion: 1, status: 'pending', snapshot: snapshot(),
  candidate: snapshot('11', 'd'.repeat(64)), receipts: [] });
function requireFunction(name) {
  assert.equal(typeof notifier[name], 'function', `${name} is not implemented`);
  return notifier[name];
}

test('first publication establishes a silent baseline instead of pinging old catalog', () => {
  const result = requireFunction('planPublication')(null, snapshot());
  assert.equal(result.mode, 'seed');
  assert.equal(result.state.status, 'complete');
  assert.equal(result.state.snapshot.sequence, '10');
  assert.deepEqual(result.batches, []);
});
test('an already handled publication has no announcement', () => {
  const result = requireFunction('planPublication')(completed(snapshot()), snapshot());
  assert.equal(result.mode, 'skip');
  assert.deepEqual(result.batches, []);
});
test('policy-only publication advances baseline without posting', () => {
  const result = requireFunction('planPublication')(completed(snapshot()), snapshot('11'));
  assert.equal(result.mode, 'advance');
  assert.equal(result.state.snapshot.sequence, '11');
  assert.deepEqual(result.batches, []);
});
test('changed installable route plans one everyone announcement with pending state', () => {
  const result = requireFunction('planPublication')(completed(snapshot()), snapshot('11', 'd'.repeat(64)));
  assert.equal(result.mode, 'send');
  assert.equal(result.state.status, 'pending');
  assert.equal(result.state.snapshot.sequence, '10');
  assert.equal(result.state.candidate.sequence, '11');
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].content.match(/@everyone/g)?.length, 1);
  assert.deepEqual(result.batches[0].allowed_mentions.parse, ['everyone']);
});
test('publication rollback and sequence collisions cannot announce', () => {
  const plan = requireFunction('planPublication');
  assert.throws(() => plan(completed(snapshot('11')), snapshot()), /rollback/i);
  assert.throws(() => plan(completed(snapshot()), { ...snapshot(), contentSha256: 'e'.repeat(64) }), /collision/i);
});
test('unfinished send blocks automatic retry, including subsequent publication', () => {
  const plan = requireFunction('planPublication');
  assert.throws(() => plan(pending(), snapshot('11', 'd'.repeat(64))), /interrupted/i);
  assert.throws(() => plan(pending(), snapshot('12', 'f'.repeat(64))), /interrupted/i);
});
test('explicit skip-interrupted recovery marks candidate handled without repeating it', () => {
  const result = requireFunction('planPublication')(pending(), snapshot('11', 'd'.repeat(64)), { recovery: 'skip-interrupted' });
  assert.equal(result.mode, 'advance');
  assert.equal(result.state.status, 'complete');
  assert.equal(result.state.snapshot.sequence, '11');
  assert.deepEqual(result.batches, []);
});
test('malformed persisted state fails closed rather than silently resetting baseline', () => {
  assert.throws(() => requireFunction('planPublication')({ schemaVersion: 1, status: 'complete' }, snapshot()), /state|snapshot/i);
});
test('state artifacts ignore expired, other branches and current attempt, retain earlier rerun', () => {
  const artifact = (id, name, run = 1, branch = 'main', expired = false) => ({ id, name, expired,
    created_at: `2026-10-12T15:48:${String(id).padStart(2, '0')}Z`,
    workflow_run: { id: run, head_branch: branch } });
  const result = requireFunction('selectStateArtifact')([
    artifact(1, 'discord-state-result-1-1'),
    artifact(2, 'other-artifact'),
    artifact(3, 'discord-state-result-2-1', 2, 'feature'),
    artifact(4, 'discord-state-result-2-1', 2, 'main', true),
    artifact(5, 'discord-state-intent-5-1', 5),
    artifact(6, 'discord-state-intent-5-2', 5),
  ], { runId: '5', attempt: '2' });
  assert.equal(result.id, 5);
});

const historyArtifact = (id, name, created_at) => ({ id, name, created_at, expired: false,
  workflow_run: { id: Number(name.split('-')[3]), head_branch: 'main' } });

test('newer confirmed result wins with the real non-chronological GitHub artifact IDs', () => {
  const intent = historyArtifact(11758200101, 'discord-state-intent-38272684516-1', '2026-10-12T15:48:34Z');
  const result = historyArtifact(11757816707, 'discord-state-result-38272684516-1', '2026-10-12T15:48:40Z');
  for (const artifacts of [[intent, result], [result, intent]]) {
    assert.equal(requireFunction('selectStateArtifact')(artifacts), result);
  }
});

test('publication chronology does not depend on artifact IDs or API array order', () => {
  const earlier = historyArtifact(100, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  const latest = historyArtifact(1, 'discord-state-intent-11-1', '2026-10-13T08:40:00Z');
  for (const artifacts of [[earlier, latest], [latest, earlier]]) {
    assert.equal(requireFunction('selectStateArtifact')(artifacts), latest);
  }
});

test('result supersedes the matching intent even when creation timestamps are equal', () => {
  const intent = historyArtifact(100, 'discord-state-intent-10-1', '2026-10-12T15:48:40Z');
  const result = historyArtifact(1, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  assert.equal(requireFunction('selectStateArtifact')([intent, result]), result);
});

test('matching result preference and group chronology are independent of metadata order', () => {
  const result = historyArtifact(1, 'discord-state-result-10-1', '2026-10-12T15:48:38Z');
  const other = historyArtifact(2, 'discord-state-result-9-1', '2026-10-12T15:48:39Z');
  const intent = historyArtifact(100, 'discord-state-intent-10-1', '2026-10-12T15:48:40Z');
  for (const artifacts of [[intent, other, result], [result, intent, other], [other, result, intent]]) {
    assert.equal(requireFunction('selectStateArtifact')(artifacts), result);
  }
});

test('an interrupted result remains pending and cannot authorize automatic replay', () => {
  const intent = historyArtifact(100, 'discord-state-intent-10-1', '2026-10-12T15:48:34Z');
  const result = historyArtifact(1, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  const selected = requireFunction('selectStateArtifact')([intent, result]);
  assert.equal(selected, result);
  const interrupted = { ...pending(), receipts: [{ id: '1234567890', everyoneParsed: true }] };
  assert.throws(() => requireFunction('planPublication')(interrupted, snapshot('12')), /interrupted/i);
});

test('a newer pending rerun is not hidden by an older completed attempt', () => {
  const result = historyArtifact(100, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  const intent = historyArtifact(1, 'discord-state-intent-10-2', '2026-10-12T15:48:41Z');
  assert.equal(requireFunction('selectStateArtifact')([result, intent]), intent);
  assert.throws(() => requireFunction('planPublication')(pending(), snapshot('12')), /interrupted/i);
});

test('a higher pending attempt wins a creation-time tie without masking interruption', () => {
  const result = historyArtifact(100, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  const intent = historyArtifact(1, 'discord-state-intent-10-2', '2026-10-12T15:48:40Z');
  assert.equal(requireFunction('selectStateArtifact')([result, intent]), intent);
});

test('eligible history with missing or malformed creation time fails closed', () => {
  const valid = historyArtifact(100, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  for (const timestamp of [undefined, '', 'not-a-date']) {
    const invalid = historyArtifact(1, 'discord-state-intent-11-1', timestamp);
    assert.throws(() => requireFunction('selectStateArtifact')([valid, invalid]), /creation time/i);
  }
});

test('ignored artifacts do not need valid chronology and cannot reset history', () => {
  const valid = historyArtifact(1, 'discord-state-result-10-1', '2026-10-12T15:48:40Z');
  const expired = { ...historyArtifact(100, 'discord-state-intent-11-1'), expired: true };
  const otherBranch = { ...historyArtifact(101, 'discord-state-intent-11-1'), workflow_run: { id: 11, head_branch: 'feature' } };
  const current = historyArtifact(102, 'discord-state-intent-12-1');
  assert.equal(requireFunction('selectStateArtifact')([expired, otherBranch, current, valid],
    { runId: '12', attempt: '1' }), valid);
  assert.equal(requireFunction('selectStateArtifact')([]), null);
});

const planForSend = () => ({ mode: 'send', state: pending(), changes: [],
  batches: [{ content: '@everyone\nNew content is available.', allowed_mentions: { parse: ['everyone'] },
    embeds: [{ title: 'Lone Destructor', image: { url: 'attachment://comparison-0.webp' } }] }],
  attachments: [{ filename: 'comparison-0.webp', bytes: Buffer.from('test-image') }],
});
test('sender requires durable intent before any webhook request', async () => {
  let requests = 0;
  await assert.rejects(requireFunction('sendDiscordPlan')(planForSend(), {
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    fetchImpl: async () => { requests++; return new Response('{}'); },
  }), /intent/i);
  assert.equal(requests, 0);
});
test('sender uploads paired attachment and requests confirmation, not suppressing notifications', async () => {
  const plan = planForSend();
  const sent = [];
  const result = await requireFunction('sendDiscordPlan')(plan, { intentRecorded: true,
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).searchParams.get('wait'), 'true');
      assert.equal(request.method, 'POST');
      const payload = JSON.parse(request.body.get('payload_json'));
      assert.deepEqual(payload.allowed_mentions.parse, ['everyone']);
      assert.equal(payload.flags, undefined);
      assert.equal(payload.attachments[0].filename, 'comparison-0.webp');
      assert.equal(request.body.get('files[0]').name, 'comparison-0.webp');
      return Response.json({ id: '1234567890', mention_everyone: true, mentions: [], mention_roles: [] });
    }, onProgress: async state => { sent.push(structuredClone(state)); },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.snapshot.sequence, '11');
  assert.equal(result.receipts[0].id, '1234567890');
  assert.equal(sent.at(-1).status, 'complete');
});
test('an uncertain network failure makes only one request and keeps pending state', async () => {
  const plan = planForSend();
  let requests = 0;
  await assert.rejects(requireFunction('sendDiscordPlan')(plan, { intentRecorded: true,
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    fetchImpl: async () => { requests++; throw new Error('https://discord.com/api/webhooks/123/SECRET'); },
  }), error => /confirmation|interrupted/i.test(error.message) && !error.message.includes('SECRET'));
  assert.equal(requests, 1);
  assert.equal(plan.state.status, 'pending');
});
test('definite HTTP failure and missing confirmation do not mark content announced', async () => {
  for (const response of [new Response('', { status: 429 }), Response.json({})]) {
    const plan = planForSend();
    await assert.rejects(requireFunction('sendDiscordPlan')(plan, { intentRecorded: true,
      webhookUrl: 'https://discord.com/api/webhooks/123/test-token', fetchImpl: async () => response,
    }));
    assert.equal(plan.state.status, 'pending');
    assert.deepEqual(plan.state.receipts, []);
  }
});
test('blocked everyone mention records delivered message without duplicate retry', async () => {
  const result = await requireFunction('sendDiscordPlan')(planForSend(), { intentRecorded: true,
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    fetchImpl: async () => Response.json({ id: '1234567890', mention_everyone: false, mentions: [], mention_roles: [] }),
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.receipts[0].everyoneParsed, false);
});
test('wrong webhook host or credentials are rejected without leaking configuration', async () => {
  let requests = 0;
  for (const url of ['http://discord.com/api/webhooks/123/SECRET', 'https://evil.example/api/webhooks/123/SECRET',
    'https://SECRET@discord.com/api/webhooks/123/SECRET']) {
    await assert.rejects(requireFunction('sendDiscordPlan')(planForSend(), { intentRecorded: true,
      webhookUrl: url, fetchImpl: async () => { requests++; },
    }), error => !error.message.includes('SECRET'));
  }
  assert.equal(requests, 0);
});
test('sender loads only each batch attachments and preserves global attachment filenames', async () => {
  const plan = planForSend();
  delete plan.attachments;
  plan.batches.push({ content: '', allowed_mentions: { parse: [] },
    embeds: [{ title: 'Wonder Park', image: { url: 'attachment://comparison-5.webp' } }] });
  const loaded = [];
  let requests = 0;
  const result = await requireFunction('sendDiscordPlan')(plan, { intentRecorded: true,
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    getAttachment: async filename => { loaded.push(filename); return { filename, bytes: Buffer.from('image') }; },
    fetchImpl: async (_, request) => {
      const payload = JSON.parse(request.body.get('payload_json'));
      assert.equal(payload.attachments.length, 1);
      assert.equal(payload.attachments[0].id, 0);
      assert.equal(payload.attachments[0].filename, requests === 0 ? 'comparison-0.webp' : 'comparison-5.webp');
      assert.equal(loaded.length, requests + 1, 'Later batches must not be loaded before this send');
      requests++;
      return Response.json({ id: String(1000 + requests), mention_everyone: requests === 1, mentions: [], mention_roles: [] });
    },
  });
  assert.equal(result.receipts.length, 2);
  assert.deepEqual(loaded, ['comparison-0.webp', 'comparison-5.webp']);
});
test('partial multi-message failure preserves confirmed receipts without re-pinging or retrying', async () => {
  const plan = planForSend();
  plan.batches.push({ content: '', allowed_mentions: { parse: [] }, embeds: plan.batches[0].embeds });
  let requests = 0;
  let persisted;
  await assert.rejects(requireFunction('sendDiscordPlan')(plan, { intentRecorded: true,
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    fetchImpl: async () => ++requests === 1 ? Response.json({ id: '123', mention_everyone: true, mentions: [], mention_roles: [] }) : new Response('', { status: 500 }),
    onProgress: async state => { persisted = structuredClone(state); },
  }));
  assert.equal(requests, 2);
  assert.equal(persisted.status, 'pending');
  assert.equal(persisted.receipts[0].id, '123');
  assert.throws(() => requireFunction('planPublication')(persisted, snapshot('11', 'd'.repeat(64))), /interrupted/i);
});
test('multi-message sends wait for the exhausted Discord bucket after saving its receipt', async () => {
  const plan = planForSend();
  plan.batches.push({ content: '', allowed_mentions: { parse: [] }, embeds: plan.batches[0].embeds });
  const events = [];
  await requireFunction('sendDiscordPlan')(plan, { intentRecorded: true,
    webhookUrl: 'https://discord.com/api/webhooks/123/test-token',
    fetchImpl: async () => {
      const id = events.filter(event => event === 'post').length + 1;
      events.push('post');
      return Response.json({ id: String(id), mention_everyone: id === 1 },
        { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.35' } });
    },
    onProgress: async () => { events.push('save'); },
    wait: async milliseconds => { events.push(milliseconds); },
  });
  assert.deepEqual(events, ['post', 'save', 400, 'post', 'save', 'save']);
});
