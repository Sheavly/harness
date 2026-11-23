/**
 * The denial matrix: what an extension cannot do on the run, whatever it declares in `grants`.
 * Every test runs for a built-in and a third-party probe that declare the same manifest with
 * every grant, so a denied action is denied by the shape of the service, not by who asks. Only
 * package subpaths are imported, like the other third-party tests.
 */
import { describe, expect, it } from 'vitest';
import { ScopeArgumentError } from '@sheavly/host/errors/scopes.errors';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { TaskError } from '@sheavly/runtime/errors/tasks.errors';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { MemoryOutputStore } from '@sheavly/testing/store/memory-output.fake';
import { scopeProbe } from '../../testing/scope-probe.fake.js';
import { PROBE_KINDS } from '../../testing/testing.constants.js';
import { useBackendRuns } from '../../testing/backend-run.fake.js';

const open = useBackendRuns();

/** The surface of the run's registries an extension must never be handed, by what it would let it do. */
const DENIED_SURFACE = [
  {
    action: 'publish to the stream',
    // Every way the registry adds to the stream, read from it so a new one is denied too.
    names: [
      ...Object.getOwnPropertyNames(SessionRegistry.prototype).filter((name) =>
        name.startsWith('publish'),
      ),
      'subscribeEntries',
      'stream',
    ],
  },
  {
    action: 'end, idle, resume or release a session',
    names: ['end', 'idle', 'resume', 'release', 'releaseAgent', 'startMain'],
  },
  {
    action: 'queue a notice or take what is queued for a session',
    names: ['queueNotice', 'takeNotices', 'takeMessages', 'hasMessages', 'nextMessage'],
  },
  {
    action: 'cancel every task, or every task of a session, without a session',
    names: ['cancelAll', 'cancelSession', 'takeDeliveries', 'releaseFinished', 'runningTasks'],
  },
  {
    action: 'subscribe to every update of the run',
    names: ['subscribe', 'subscribeEntries'],
  },
];

/** A brand-new `callId`, for a child the test starts by hand. */
const call = (id: string) => callIdSchema.parse(id);

describe.each(PROBE_KINDS)('$label extension with every grant', ({ origin }) => {
  /** Opens a run with the probe (and `others`, which declare the same manifest) over an output store. */
  const openProbe = async (params: { others?: string[]; emits?: boolean } = {}) => {
    const { others = [], emits } = params;
    const probe = scopeProbe({ name: 'probe', origin, emits });
    const rest = others.map((name) => scopeProbe({ name, origin }));
    const harness = await open({
      extensions: [probe.extension, ...rest.map((other) => other.extension)],
      outputs: new MemoryOutputStore(),
    });

    return { probe, rest, harness };
  };

  /** Opens a run where a second extension has started a task that keeps running in the main session. */
  const openWithForeignTask = async () => {
    const { probe, rest, harness } = await openProbe({ others: ['other'] });
    const other = rest[0];
    const foreign = other?.startWaiting(harness.mainSession.id);

    if (!other || !foreign) throw new Error('the other extension did not start a task');

    return { probe, other, foreign, harness };
  };

  describe.each(DENIED_SURFACE)('cannot $action', ({ names }) => {
    it('holds a scope without any of those members, on every service it can read', async () => {
      const { probe } = await openProbe();

      for (const [key, scope] of Object.entries(probe.scopes())) {
        // The model scope is the provider: its `stream` is the model call that `model:call` grants.
        const absent = key === 'model' ? names.filter((name) => name !== 'stream') : names;

        for (const name of absent) {
          expect(name in (scope ?? {}), `${key}.${name}`).toBe(false);
        }
      }
    });
  });

  it('cannot answer, subscribe to or read the approvals: it only requests and reads whether anyone listens', async () => {
    const { probe } = await openProbe();
    const { approvals } = probe.scopes();

    expect(typeof approvals.request).toBe('function');
    expect(typeof approvals.listening).toBe('boolean');

    for (const name of ['respond', 'subscribe', 'observe', 'pending', 'screen']) {
      expect(name in approvals, name).toBe(false);
    }
  });

  describe('cannot send as the user', () => {
    it('refuses a message from the user, and nothing is queued', async () => {
      const { probe, harness } = await openProbe();
      const { child } = probe.scopes();
      const started = child.startChild({
        parentId: harness.mainSession.id,
        startedByCall: call('c1'),
        title: 'child',
      });

      expect(() => child.send({ id: started.id, content: 'hi', from: 'user' as never })).toThrow(
        /Unknown session user/,
      );
      expect(harness.sessions.hasMessages(started.id)).toBe(false);
    });

    it('refuses a message to the main session, which it did not start', async () => {
      const { probe, harness } = await openProbe();

      expect(() =>
        probe.scopes().child.send({
          id: harness.mainSession.id,
          content: 'hi',
          from: harness.mainSession.id,
        }),
      ).toThrow(/Unknown session/);
      expect(harness.sessions.hasMessages(harness.mainSession.id)).toBe(false);
    });
  });

  describe('cannot cancel a task it did not start', () => {
    it('reads another extension’s task as unknown, and it keeps running', async () => {
      const { probe, other, foreign, harness } = await openWithForeignTask();
      const { tasks } = probe.scopes();

      expect(tasks.get(foreign.id)).toBeUndefined();
      expect(tasks.report(foreign.id)).toBeUndefined();
      expect(tasks.list()).toEqual([]);
      await expect(tasks.cancel(foreign.id)).resolves.toBeUndefined();
      expect(() =>
        tasks.group({ ids: [foreign.id], reason: 'x', sessionId: harness.mainSession.id }),
      ).toThrow(TaskError);
      expect(harness.tasks.get(foreign.id)?.status).toBe('running');

      await other?.scopes().tasks.cancel(foreign.id);
    });

    it('cancels it only through task-control, and only in the calling session', async () => {
      const { probe, foreign, harness } = await openWithForeignTask();
      const { control, child } = probe.scopes();
      const stranger = child.startChild({
        parentId: harness.mainSession.id,
        startedByCall: call('c1'),
        title: 'child',
      });

      await expect(
        control.cancel({ id: foreign.id, sessionId: stranger.id }),
      ).resolves.toBeUndefined();
      expect(harness.tasks.get(foreign.id)?.status).toBe('running');

      await control.cancel({ id: foreign.id, sessionId: harness.mainSession.id });

      expect(harness.tasks.get(foreign.id)?.status).toBe('cancelled');
    });

    it('never reads an absent session as every session: each task-control call needs one', async () => {
      const { probe, harness } = await openProbe();
      const { control } = probe.scopes();
      const noSession = undefined as never;

      await expect(control.cancel({ id: 'x' as never, sessionId: noSession })).rejects.toThrow(
        ScopeArgumentError,
      );
      expect(() => control.list(noSession)).toThrow(ScopeArgumentError);
      expect(() => control.report('x' as never, noSession)).toThrow(ScopeArgumentError);
      expect(() => control.getOwned({ id: 'x' as never, sessionId: noSession })).toThrow(
        ScopeArgumentError,
      );
      expect(() => control.group({ ids: [], reason: 'x', sessionId: noSession })).toThrow(
        ScopeArgumentError,
      );
      expect(harness.tasks.list()).toEqual([]);
    });
  });

  describe('cannot queue a notice or publish an event except through the declared emit capability', () => {
    it('emits what it declared and contributed: the event on the stream, the notice queued', async () => {
      const { probe, harness } = await openProbe({ emits: true });
      const heard: unknown[] = [];

      harness.sessions.subscribeEntries((entry) => heard.push(entry), { replay: true });
      probe.emit().event({ kind: probe.eventKind, data: { done: 1 }, text: 'one done' });
      probe.emit().notice({ topic: probe.topic, data: { done: 1 }, text: 'one done' });

      expect(heard.at(-1)).toMatchObject({
        sessionId: harness.mainSession.id,
        event: { type: 'extension_event', extension: 'probe', kind: probe.eventKind },
      });
      expect(harness.sessions.takeNotices(harness.mainSession.id)).toHaveLength(1);
    });

    it('cannot emit at all without the emits it declares, though it holds every scoped service', async () => {
      const { probe, harness } = await openProbe();
      const heard: unknown[] = [];

      harness.sessions.subscribeEntries((entry) => heard.push(entry), { replay: true });

      expect(() =>
        probe.emit().event({ kind: probe.eventKind, data: { done: 1 }, text: 'x' }),
      ).toThrow(/Extension probe uses event/);
      expect(() =>
        probe.emit().notice({ topic: probe.topic, data: { done: 1 }, text: 'x' }),
      ).toThrow(/Extension probe uses notice/);
      expect(JSON.stringify(heard)).not.toContain('extension_event');
      expect(harness.sessions.takeNotices(harness.mainSession.id)).toEqual([]);
    });
  });
});
