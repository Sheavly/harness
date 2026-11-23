import type { ChildSessionScope } from '@sheavly/extension/run-services/run-services.types';
import type { SessionId, SessionRef } from '@sheavly/protocol/session/session.types';
import { SessionError } from '@sheavly/runtime/errors/sessions.errors';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { ChildRunningError, ScopeLimitError } from '../errors/scopes.errors.js';
import { runChildLoop } from './child-run.helper.js';
import { requireOpenSession } from './open-session.helper.js';
import { MAX_SCOPE_CHILDREN } from './run-services.constants.js';
import type { RunLoop } from './run-services.types.js';
import type { ScopeGuard } from './scope-guard.service.js';

/**
 * `ChildSessionScope` for one extension. It remembers the sub-agents it started (a private set,
 * so another extension's scope, built over the same registry, owns its own) and acts only on
 * those: any other id reads as an unknown session. The registry and the task registry stay
 * private; `runChild` is the one place they reach the loop.
 */
export class ChildSessionsScope implements ChildSessionScope {
  readonly #guard: ScopeGuard<'child-sessions'>;
  readonly #registry: SessionRegistry;
  readonly #tasks: TaskRegistry;
  readonly #main: SessionRef;
  readonly #runLoop: RunLoop;
  /** Private frozen records: only copies of them ever leave the scope. */
  readonly #owned = new Map<SessionId, SessionRef>();
  /** The children with a `runChild` in flight: a second run on one is refused. */
  readonly #running = new Set<SessionId>();
  /** The children this extension has started, shared with its `background-tasks` scope. */
  readonly #started: Set<SessionId>;

  constructor(params: {
    guard: ScopeGuard<'child-sessions'>;
    registry: SessionRegistry;
    tasks: TaskRegistry;
    main: SessionRef;
    runLoop: RunLoop;
    started?: Set<SessionId>;
  }) {
    this.#started = params.started ?? new Set();
    this.#guard = params.guard;
    this.#registry = params.registry;
    this.#tasks = params.tasks;
    this.#main = Object.freeze({ ...params.main });
    this.#runLoop = params.runLoop;
    Object.freeze(this);
  }

  startChild: ChildSessionScope['startChild'] = (params) => {
    const { parentId, startedByCall, title } = params;

    this.#guard.enter('startChild');

    if (parentId !== this.#main.id) this.#requireOwned(parentId);

    this.#requireRoom();

    const child = this.#registry.startChild({ parentId, startedByCall, title });

    this.#owned.set(child.id, Object.freeze({ ...child }));
    this.#started.add(child.id);

    // A different object from the one kept: whatever the caller does to it, the scope's own
    // record (what the loop is handed) stays as the registry made it.
    return Object.freeze({ ...child });
  };

  setModel: ChildSessionScope['setModel'] = (params) => {
    this.#guard.enter('setModel');
    this.#requireOwned(params.id);
    this.#registry.setModel(params);
  };

  send: ChildSessionScope['send'] = (params) => {
    this.#guard.enter('send');
    this.#requireOwned(params.id);

    if (params.from !== this.#main.id) this.#requireOwned(params.from);

    this.#registry.send(params);
  };

  report: ChildSessionScope['report'] = (params) => {
    this.#guard.enter('report');
    this.#requireOwned(params.id);
    this.#registry.report(params);
  };

  onUpdate: ChildSessionScope['onUpdate'] = (listener) => {
    this.#guard.enter('onUpdate');

    return this.#guard.track(
      this.#registry.subscribe((update) => {
        if (this.#owned.has(update.session.id)) listener(update);
      }),
    );
  };

  // Async so a refusal rejects, like any failure of the run, instead of throwing before a promise exists.
  runChild: ChildSessionScope['runChild'] = async (params) => {
    this.#guard.enter('runChild');

    const { child: given, ...run } = params;

    const child = this.#requireOwned(given.id);

    requireOpenSession({ sessions: this.#registry, id: child.id, refused: 'it cannot run' });

    if (this.#running.has(child.id)) throw new ChildRunningError({ sessionId: child.id });

    this.#running.add(child.id);

    try {
      return await runChildLoop({
        runLoop: this.#runLoop,
        registry: this.#registry,
        tasks: this.#tasks,
        child,
        run,
      });
    } finally {
      this.#running.delete(child.id);
    }
  };

  /**
   * Refuses a new child when the scope holds `MAX_SCOPE_CHILDREN` already. A child released
   * elsewhere (the loop releases a delivered sub-agent) is forgotten first, so it stops counting.
   */
  #requireRoom(): void {
    for (const id of new Set([...this.#owned.keys(), ...this.#started])) {
      if (this.#registry.get(id)) continue;

      this.#owned.delete(id);
      this.#started.delete(id);
    }

    if (this.#owned.size >= MAX_SCOPE_CHILDREN) {
      throw new ScopeLimitError({ limit: MAX_SCOPE_CHILDREN, what: 'sub-agents' });
    }
  }

  /** The session `id` if this scope started it; anything else is refused as unknown. */
  #requireOwned(id: SessionId): SessionRef {
    const child = this.#owned.get(id);

    if (child) return child;

    throw new SessionError({
      reason: 'unknown_session',
      sessionId: id,
      message: `Unknown session ${id}`,
    });
  }
}
