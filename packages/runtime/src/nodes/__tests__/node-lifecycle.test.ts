import { NODE_STATE_OF_OUTCOME, RUN_OUTCOMES } from '@sheavly/protocol/status/status.constants';
import { useFixedClock } from '@sheavly/testing/clock/fixed-clock.fake';
import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../node-registry.service.js';
import type { NodeKind, NodeRecord } from '../nodes.types.js';

const clock = useFixedClock();

const KINDS: NodeKind[] = ['agent', 'command', 'service', 'notes.sync'];
const NON_AGENTS: NodeKind[] = ['command', 'service', 'notes.sync'];
const ENDS = ['completed', 'failed', 'cancelled'] as const;
/** The outcome of a run that ends an agent in each of those states. */
const OUTCOME_OF = { completed: 'completed', failed: 'failed', cancelled: 'interrupted' } as const;

function started(kind: NodeKind) {
  const registry = new NodeRegistry();
  const node = registry.open({ kind, title: 'work' });

  return { registry, node };
}

/** Asserts that `act` is refused with a `NodeError` of `reason`. */
function refuses(act: () => unknown, reason: string): void {
  expect(act).toThrow(expect.objectContaining({ reason }));
}

/** Ends `node` as its kind ends: an agent with an outcome, anything else with a state. */
function end(params: {
  registry: NodeRegistry;
  node: NodeRecord;
  state: (typeof ENDS)[number];
}): boolean {
  const { registry, node, state } = params;

  return node.kind === 'agent'
    ? registry.endAgent({ id: node.id, outcome: OUTCOME_OF[state] })
    : registry.endWork({ id: node.id, state });
}

describe.each(KINDS)('a %s node', (kind) => {
  it('starts running and has not ended', () => {
    const { registry, node } = started(kind);

    expect(registry.get(node.id)).toMatchObject({ state: 'running', kind, title: 'work' });
    expect(registry.get(node.id)?.endedAt).toBeUndefined();
  });

  it.each(ENDS)('ends %s with its end time, and the first ending is kept', (state) => {
    const { registry, node } = started(kind);

    clock.advance(5);

    const endedAt = clock.at;

    expect(end({ registry, node, state })).toBe(true);
    expect(registry.get(node.id)).toMatchObject({ state, endedAt });

    // A second ending, of any kind, changes nothing: a terminal state is reached once.
    for (const other of ENDS) {
      clock.advance(5);
      expect(end({ registry, node, state: other })).toBe(false);
    }

    expect(registry.get(node.id)).toMatchObject({ state, endedAt });
  });

  it('is lost only through lose, the repair of a reopen, and stays lost', () => {
    const { registry, node } = started(kind);

    expect(registry.lose(node.id)).toBe(true);
    expect(registry.get(node.id)).toMatchObject({ state: 'lost', endedAt: clock.at });

    for (const state of ENDS) expect(end({ registry, node, state })).toBe(false);

    expect(registry.lose(node.id)).toBe(false);
    expect(registry.get(node.id)?.state).toBe('lost');
  });

  it.each(ENDS)('cannot be lost once it has ended %s', (state) => {
    const { registry, node } = started(kind);

    end({ registry, node, state });

    expect(registry.lose(node.id)).toBe(false);
    expect(registry.get(node.id)?.state).toBe(state);
  });
});

describe.each(NON_AGENTS)('a %s node, which is never idle', (kind) => {
  it('refuses to go idle or run again, whatever state it is in', () => {
    const { registry, node } = started(kind);
    const idle = () => registry.idle({ id: node.id, outcome: 'completed' });

    refuses(idle, 'not_an_agent');
    refuses(() => registry.resume(node.id), 'not_an_agent');

    registry.endWork({ id: node.id, state: 'completed' });

    refuses(idle, 'not_an_agent');
  });

  it('cannot be ended as an agent is, with the outcome of a run', () => {
    const { registry, node } = started(kind);

    refuses(() => registry.endAgent({ id: node.id, outcome: 'completed' }), 'not_an_agent');
    expect(registry.get(node.id)?.state).toBe('running');
  });
});

describe('an agent node', () => {
  it('goes idle between prompts with how the run ended, and runs again', () => {
    const { registry, node } = started('agent');

    expect(registry.idle({ id: node.id, outcome: 'max_turns' })).toBe(true);
    expect(registry.get(node.id)).toMatchObject({ state: 'idle', lastOutcome: 'max_turns' });
    expect(registry.get(node.id)?.endedAt).toBeUndefined();

    registry.resume(node.id);

    expect(registry.get(node.id)).toMatchObject({ state: 'running', lastOutcome: 'max_turns' });
    expect(registry.idle({ id: node.id, outcome: 'completed' })).toBe(true);
    expect(registry.get(node.id)?.lastOutcome).toBe('completed');
  });

  it('goes idle only from running: an idle one stays as it is', () => {
    const { registry, node } = started('agent');

    registry.idle({ id: node.id, outcome: 'completed' });

    expect(registry.idle({ id: node.id, outcome: 'failed' })).toBe(false);
    expect(registry.get(node.id)?.lastOutcome).toBe('completed');
  });

  it('refuses to run again unless it is idle', () => {
    const { registry, node } = started('agent');

    refuses(() => registry.resume(node.id), 'invalid_transition');

    registry.endAgent({ id: node.id, outcome: 'failed' });

    refuses(() => registry.resume(node.id), 'invalid_transition');
  });

  it('does not go idle once it has ended, and does nothing', () => {
    const { registry, node } = started('agent');

    registry.endAgent({ id: node.id, outcome: 'interrupted' });

    expect(registry.idle({ id: node.id, outcome: 'completed' })).toBe(false);
    expect(registry.get(node.id)).toMatchObject({ state: 'cancelled', lastOutcome: 'interrupted' });
  });

  it('ends from idle as well, in the state its last run gives', () => {
    const { registry, node } = started('agent');

    registry.idle({ id: node.id, outcome: 'completed' });

    expect(registry.endAgent({ id: node.id, outcome: 'completed' })).toBe(true);
    expect(registry.get(node.id)?.state).toBe('completed');
  });

  it.each(RUN_OUTCOMES)(
    'ends in the state a run that ended %s gives, keeping the outcome',
    (outcome) => {
      const { registry, node } = started('agent');

      registry.endAgent({ id: node.id, outcome });

      expect(registry.get(node.id)).toMatchObject({
        state: NODE_STATE_OF_OUTCOME[outcome],
        lastOutcome: outcome,
      });
    },
  );

  it('cannot be ended as work is, with a state and no outcome', () => {
    const { registry, node } = started('agent');

    expect(() => registry.endWork({ id: node.id, state: 'completed' })).toThrow(
      expect.objectContaining({ reason: 'invalid_outcome' }),
    );
    expect(registry.get(node.id)?.state).toBe('running');
  });

  it.each([
    [
      'ended, then ended again',
      'failed',
      (r: NodeRegistry, n: NodeRecord) => r.endAgent({ id: n.id, outcome: 'interrupted' }),
    ],
    ['ended, then lost', 'failed', (r: NodeRegistry, n: NodeRecord) => r.lose(n.id)],
    ['idle, then ended, then lost', 'completed', (r: NodeRegistry, n: NodeRecord) => r.lose(n.id)],
  ])('reaches a terminal state once on the path %s', (_name, firstEnd, later) => {
    const { registry, node } = started('agent');

    if (firstEnd === 'completed') registry.idle({ id: node.id, outcome: 'completed' });

    registry.endAgent({ id: node.id, outcome: firstEnd === 'completed' ? 'completed' : 'failed' });

    const ended = registry.get(node.id);

    clock.advance(10);

    expect(later(registry, node)).toBe(false);
    expect(registry.get(node.id)).toEqual(ended);
  });

  it('reaches lost once when lost first, whatever tries to end it after', () => {
    const { registry, node } = started('agent');

    registry.lose(node.id);

    const lost = registry.get(node.id);

    clock.advance(10);

    expect(registry.endAgent({ id: node.id, outcome: 'completed' })).toBe(false);
    expect(registry.get(node.id)).toEqual(lost);
  });
});
