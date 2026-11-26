import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { watchUsage } from '@sheavly/client/usage/watch-usage.helper';
import type { ConversationId } from '@sheavly/protocol/server/server.types';
import type { UsageView } from '@sheavly/protocol/usage/usage.types';
import { until } from '@sheavly/testing/wait/until.fake';
import { testBackend } from '../../testing/backend.fake.js';
import { useSubAgentRuns } from '../../testing/sub-agent-run.fake.js';

// What a run that starts a sub-agent used, on the real backend, the real loop and the real provider
// adapter (the model answers in the responses API's own words, cache details and all), read through
// the client over the real routes: per node, in total, the cache among the tokens and the cost at the
// model's price, followed live, and kept across a restart.

const runs = useSubAgentRuns();

/** What one model call reports, as the responses API words it: 1,000 in (600 read from the cache, 100 written), 200 out. */
const REPORTED = {
  input_tokens: 1_000,
  output_tokens: 200,
  input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
};
/** USD per million tokens: a call above costs (300 × 3 + 200 × 15 + 600 × 0.3 + 100 × 3.75) / 1,000,000. */
const PRICING = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const PER_CALL = (300 * 3 + 200 * 15 + 600 * 0.3 + 100 * 3.75) / 1_000_000;
/**
 * The main agent makes three calls: the one that starts the sub-agent, the turn after the result of
 * that tool (both in its first run), and the one that answers the sub-agent's report in the run it
 * wakes. The sub-agent makes two: a status report, and its closing words.
 */
const CALLS = { main: 3, child: 2 };
/** What the first run has used when it ends: the main agent's two turns, the sub-agent still waiting. */
const AT_FIRST_RUN_END = 2;

/** Another process on the folder `base`, as after a restart, with conversation `id` reopened on it. */
async function reopenedByAnotherProcess(params: { base: string; id: ConversationId }) {
  const second = testBackend({
    home: path.join(params.base, 'home'),
    workspace: path.join(params.base, 'project'),
  });

  await second.client.call('reopenConversation', { id: params.id });

  return second;
}

describe('what a run with a sub-agent used', () => {
  it('is counted per node and in total from what the model reported, with the cache tokens and the price', async () => {
    const { backend, id, main, child } = await runs.ranFirst({
      usage: REPORTED,
      pricing: PRICING,
    });
    const snapshot = await backend.client.call('getUsage', { id });
    const calls = CALLS.main + CALLS.child;

    expect(snapshot.nodes.map(({ node, calls: made }) => [node, made])).toEqual([
      [main, CALLS.main],
      [child, CALLS.child],
    ]);
    expect(snapshot.total).toMatchObject({
      calls,
      inputTokens: 1_000 * calls,
      outputTokens: 200 * calls,
      cacheReadTokens: 600 * calls,
      cacheWriteTokens: 100 * calls,
      missingUsageCalls: 0,
      unpricedCalls: 0,
      incomplete: false,
    });
    expect(snapshot.total.estimatedCostUsd).toBeCloseTo(PER_CALL * calls, 10);
    // Each node says how much of its window its last call used, and how much the cache served.
    expect(snapshot.nodes[0]?.context).toMatchObject({ used: 1_200, cached: 600 });
    expect(snapshot.nodes[0]?.estimatedCostUsd).toBeCloseTo(PER_CALL * CALLS.main, 10);
  });

  it('counts a model with no price as unpriced, adding no cost, and still counts its tokens', async () => {
    const { backend, id } = await runs.ranFirst({ usage: REPORTED });
    const { total } = await backend.client.call('getUsage', { id });

    expect(total).toMatchObject({
      calls: CALLS.main + CALLS.child,
      unpricedCalls: CALLS.main + CALLS.child,
      estimatedCostUsd: 0,
      inputTokens: 1_000 * (CALLS.main + CALLS.child),
    });
  });

  it('is followed live by a client that starts from the snapshot, to the usage the route gives', async () => {
    const { backend, id, release } = await runs.started({ usage: REPORTED, pricing: PRICING });
    const stop = new AbortController();
    const told: UsageView[] = [];
    const watch = await watchUsage({
      client: backend.client,
      id,
      onChange: (usage) => told.push(usage),
      signal: stop.signal,
    });

    // It resolves once the server accepted the connection; the snapshot follows. The first run has
    // ended and only the main agent has called the model.
    await until(() => watch.usage().total.calls === AT_FIRST_RUN_END);

    expect(watch.usage().nodes).toHaveLength(1);

    release();
    await until(() => watch.usage().total.calls === CALLS.main + CALLS.child);

    const snapshot = await backend.client.call('getUsage', { id });

    stop.abort();
    await watch.ended;

    expect(watch.usage()).toEqual({ total: snapshot.total, nodes: snapshot.nodes });
    // Each call told of once: the snapshot with what the first run used, then one change for each
    // call after it.
    expect(told.map(({ total }) => total.calls)).toEqual([2, 3, 4, 5]);
    expect(snapshot.nodes).toHaveLength(2);
  });

  it('is kept across a restart: the first life’s nodes keep their records and the total still covers them', async () => {
    const { backend, base, id } = await runs.ranFirst({ usage: REPORTED, pricing: PRICING });
    const before = await backend.client.call('getUsage', { id });

    await backend.conversations.closeAll();

    const second = await reopenedByAnotherProcess({ base, id });
    const after = await second.client.call('getUsage', { id });

    expect(after.total).toEqual(before.total);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.total.calls).toBe(CALLS.main + CALLS.child);

    await second.conversations.closeAll();
  });

  it('says its figures are a lower bound for a conversation kept before there was a usage channel', async () => {
    const { backend, base, id } = await runs.ranFirst({ usage: REPORTED, pricing: PRICING });

    await backend.conversations.closeAll();

    // As it was kept before the channel existed: no usage channel on disk (nor its index).
    const files = await readdir(base, { recursive: true });
    const usageFiles = files.filter((file) => /(^|\/)usage\.(jsonl|idx)$/.test(file));

    expect(usageFiles.length).toBeGreaterThan(0);

    for (const file of usageFiles) await rm(path.join(base, file));

    const second = await reopenedByAnotherProcess({ base, id });
    const after = await second.client.call('getUsage', { id });

    // Nothing of what the first life used is counted, and the figures say so rather than say zero.
    expect(after).toMatchObject({ cursor: 's0', total: { calls: 0, incomplete: true }, nodes: [] });

    await second.conversations.closeAll();
  });
});
