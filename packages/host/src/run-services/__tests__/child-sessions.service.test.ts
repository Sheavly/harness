import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ExtensionUndeclaredError } from '@sheavly/extension/errors/manifest.errors';
import { ScopeDeactivatedError } from '@sheavly/extension/errors/scopes.errors';
import { CHILD_SESSIONS } from '@sheavly/extension/run-services/run-services.utils';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { sessionIdSchema } from '@sheavly/protocol/session/session.validator';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { scopeRun } from '../../testing/scope-run.fake.js';

/** The session registry's methods that add to the combined stream: no scope may hand one out. */
const PUBLISHERS = Object.getOwnPropertyNames(SessionRegistry.prototype).filter((name) =>
  name.startsWith('publish'),
);

const call = (id: string) => callIdSchema.parse(id);
// Typed as a session id, the value is the one a user's message carries.
const userSender = sessionIdSchema.parse('user');
const grants = ['sub-agent:create', 'sub-agent:message', 'sub-agent:observe', 'sub-agent:report'];
const owner = (name: string) => ({ name, requires: [CHILD_SESSIONS.name], grants });

/** Two extensions with the same grants over one run, and the child each started under the main session. */
async function twoOwners() {
  const run = scopeRun();

  await run.activate([owner('a'), owner('b')]);

  const a = run.servicesOf('a').get(CHILD_SESSIONS);
  const b = run.servicesOf('b').get(CHILD_SESSIONS);
  const parentId = run.harness.mainSession.id;
  const childOfA = a.startChild({ parentId, startedByCall: call('ca'), title: 'a' });
  const childOfB = b.startChild({ parentId, startedByCall: call('cb'), title: 'b' });

  return { run, a, b, childOfA, childOfB, parentId };
}

describe('the child-sessions service: grants', () => {
  it('refuses each verb without its grant, naming the extension and the grant', async () => {
    const run = scopeRun();
    const main = run.harness.mainSession.id;

    await run.activate([{ name: 'none', requires: [CHILD_SESSIONS.name], grants: [] }]);

    const scope = run.servicesOf('none').get(CHILD_SESSIONS);
    const verbs: [string, () => unknown][] = [
      [
        'sub-agent:create',
        () => scope.startChild({ parentId: main, startedByCall: call('c'), title: 't' }),
      ],
      [
        'sub-agent:create',
        () => scope.setModel({ id: main, modelId: modelIdSchema.parse(randomUUID()) }),
      ],
      ['sub-agent:message', () => scope.send({ id: main, content: 'x', from: main })],
      ['sub-agent:report', () => scope.report({ id: main, status: 'x' })],
      ['sub-agent:observe', () => scope.onUpdate(() => undefined)],
    ];

    for (const [grant, verb] of verbs) {
      expect(verb).toThrow(ExtensionUndeclaredError);
      expect(verb).toThrow(new RegExp(`none.*${grant}|${grant}.*none`, 's'));
    }
  });

  it('checks each grant on its own: create alone does not allow messaging', async () => {
    const run = scopeRun();
    const main = run.harness.mainSession.id;

    await run.activate([
      { name: 'maker', requires: [CHILD_SESSIONS.name], grants: ['sub-agent:create'] },
    ]);

    const scope = run.servicesOf('maker').get(CHILD_SESSIONS);
    const child = scope.startChild({ parentId: main, startedByCall: call('c'), title: 't' });

    expect(() => scope.send({ id: child.id, content: 'x', from: main })).toThrow(
      /sub-agent:message/,
    );
    expect(() => scope.report({ id: child.id, status: 'x' })).toThrow(/sub-agent:report/);
    expect(() => scope.onUpdate(() => undefined)).toThrow(/sub-agent:observe/);
  });
});

describe('the child-sessions service: starting', () => {
  it('starts a child under the main session and under a child it owns', async () => {
    const { a, childOfA } = await twoOwners();
    const grandchild = a.startChild({
      parentId: childOfA.id,
      startedByCall: call('deep'),
      title: 'deep',
    });

    expect(grandchild.depth).toBe(childOfA.depth + 1);
  });

  it('refuses a parent it does not own, as an unknown session', async () => {
    const { a, childOfB } = await twoOwners();

    expect(() =>
      a.startChild({ parentId: childOfB.id, startedByCall: call('x'), title: 'x' }),
    ).toThrow(SessionError);
    expect(() =>
      a.startChild({ parentId: childOfB.id, startedByCall: call('x'), title: 'x' }),
    ).toThrow(/Unknown session/);
  });

  it('accepts a call id a sibling used before: a provider may reuse them across turns', async () => {
    const { a, b, parentId } = await twoOwners();

    expect(() =>
      a.startChild({ parentId, startedByCall: call('ca'), title: 'again' }),
    ).not.toThrow();
    expect(() => b.startChild({ parentId, startedByCall: call('ca'), title: 'x' })).not.toThrow();
  });

  it('returns a frozen copy: changing it throws and cannot redirect what the scope does', async () => {
    const { run, a, childOfA, parentId } = await twoOwners();
    const forged = childOfA as { id: string };

    expect(Object.isFrozen(childOfA)).toBe(true);
    expect(() => {
      forged.id = parentId;
    }).toThrow(TypeError);
    expect(childOfA.id).not.toBe(parentId);
    // The same child, named by the unchanged copy, still runs as itself.
    expect(() => a.report({ id: childOfA.id, status: 'ok' })).not.toThrow();
    expect(run.harness.sessions.get(parentId)?.status).toBeUndefined();
  });

  it('hands out a new copy each time and keeps its own record apart from them', async () => {
    const { a, childOfA, parentId } = await twoOwners();
    const other = a.startChild({ parentId, startedByCall: call('x'), title: 'x' });

    expect(other).not.toBe(childOfA);
    expect(Object.isFrozen(other)).toBe(true);
  });
});

describe('the child-sessions service: ownership', () => {
  it('lets each extension act on its own child and treats a foreign one as unknown', async () => {
    const { run, a, childOfA, childOfB } = await twoOwners();
    const main = run.harness.mainSession.id;
    const modelId = modelIdSchema.parse(randomUUID());

    a.setModel({ id: childOfA.id, modelId });
    a.send({ id: childOfA.id, content: 'hello', from: main });
    a.report({ id: childOfA.id, status: 'working' });

    expect(run.harness.sessions.get(childOfA.id)).toMatchObject({ modelId, status: 'working' });
    expect(run.harness.sessions.hasMessages(childOfA.id)).toBe(true);

    for (const act of [
      () => a.setModel({ id: childOfB.id, modelId }),
      () => a.send({ id: childOfB.id, content: 'hello', from: main }),
      () => a.report({ id: childOfB.id, status: 'mine now' }),
    ]) {
      expect(act).toThrow(SessionError);
      expect(act).toThrow(/Unknown session/);
    }

    expect(run.harness.sessions.hasMessages(childOfB.id)).toBe(false);
    expect(run.harness.sessions.get(childOfB.id)?.status).toBeUndefined();
  });

  it('never lets a message come from the user, a stranger or another extension’s child', async () => {
    const { run, a, childOfA, childOfB } = await twoOwners();

    // The type forbids 'user'; a caller that ignores it is refused all the same.
    for (const from of [userSender, childOfB.id, sessionIdSchema.parse('stranger')]) {
      expect(() => a.send({ id: childOfA.id, content: 'x', from })).toThrow(SessionError);
    }

    expect(run.harness.sessions.hasMessages(childOfA.id)).toBe(false);
  });

  it('lets an owned child steer its own sub-agent, and the registry’s ancestor rule still applies', async () => {
    const { run, a, childOfA } = await twoOwners();
    const grandchild = a.startChild({
      parentId: childOfA.id,
      startedByCall: call('deep'),
      title: 'deep',
    });

    a.send({ id: grandchild.id, content: 'from its parent', from: childOfA.id });

    expect(run.harness.sessions.hasMessages(grandchild.id)).toBe(true);
    // An owned child is not an ancestor of its sibling: the registry refuses.
    const sibling = a.startChild({
      parentId: run.harness.mainSession.id,
      startedByCall: call('sib'),
      title: 'sibling',
    });

    expect(() => a.send({ id: sibling.id, content: 'x', from: childOfA.id })).toThrow(
      /did not start/,
    );
  });

  it('delivers updates of owned children only, judged when each update arrives', async () => {
    const { run, a, childOfA, childOfB } = await twoOwners();
    const heard: string[] = [];

    a.onUpdate((update) => heard.push(`${update.type}:${update.session.id}`));
    run.harness.sessions.report({ id: childOfB.id, status: 'not for a' });
    run.harness.sessions.report({ id: childOfA.id, status: 'for a' });

    const later = a.startChild({
      parentId: childOfA.id,
      startedByCall: call('later'),
      title: 'later',
    });

    run.harness.sessions.report({ id: later.id, status: 'owned later' });

    // A child is owned once `startChild` returns, so the update announcing its start is not heard.
    expect(heard).toEqual([`session_status:${childOfA.id}`, `session_status:${later.id}`]);
  });

  it('gives a second extension with the same grants its own, empty ownership', async () => {
    const { b, childOfA } = await twoOwners();

    expect(() => b.report({ id: childOfA.id, status: 'x' })).toThrow(/Unknown session/);
  });
});

describe('the child-sessions service: what it leaves out', () => {
  it('has no member that publishes, ends, releases, reads inboxes or reaches the registries', async () => {
    const { a } = await twoOwners();

    expect(PUBLISHERS).toContain('publishQueue');

    for (const name of [
      // Every way the registry adds to the stream, read from it so a new one is covered too.
      ...PUBLISHERS,
      'end',
      'idle',
      'resume',
      'release',
      'releaseAgent',
      'queueNotice',
      'takeNotices',
      'takeMessages',
      'hasMessages',
      'subscribe',
      'subscribeEntries',
      'stream',
      'cancelAll',
      'cancelSession',
      'sessions',
      'registry',
      'tasks',
    ]) {
      expect(name in a).toBe(false);
    }

    expect(Object.isFrozen(a)).toBe(true);
  });

  it('throws deactivated from every method once the host stops the extension', async () => {
    const run = scopeRun();
    const { deactivate } = await run.activate([owner('a')]);
    const scope = run.servicesOf('a').get(CHILD_SESSIONS);
    const main = run.harness.mainSession.id;
    const heard: unknown[] = [];

    scope.onUpdate((update) => heard.push(update));
    await deactivate();

    for (const act of [
      () => scope.startChild({ parentId: main, startedByCall: call('c'), title: 't' }),
      () => scope.send({ id: main, content: 'x', from: main }),
      () => scope.report({ id: main, status: 'x' }),
      () => scope.onUpdate(() => undefined),
    ]) {
      expect(act).toThrow(ScopeDeactivatedError);
    }

    run.harness.sessions.report({ id: main, status: 'later' });

    expect(heard).toEqual([]);
  });
});
