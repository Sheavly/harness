import type { BackgroundTaskScope } from '@sheavly/extension/run-services/run-services.types';
import type { TaskId } from '@sheavly/protocol/task/task.types';
import { TaskError } from '@sheavly/runtime/errors/tasks.errors';
import type { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import type { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { TaskObserver } from '@sheavly/runtime/tasks/tasks.types';
import { missingTaskMessage } from '@sheavly/runtime/tasks/tasks.utils';
import { startWork } from '@sheavly/runtime/tasks/work.utils';
import { requireOpenSession } from './open-session.helper.js';
import type { ScopeGuard } from './scope-guard.service.js';

/**
 * `BackgroundTaskScope` for one extension. It remembers the ids of the tasks it started (a
 * private set) and every method sees only those: another extension's task reads as unknown, as
 * it does for a session that does not own it. `start` refuses work for a session that is not
 * open in the run, so no task is left under an owner nothing will ever cancel.
 */
export class BackgroundTasksScope implements BackgroundTaskScope {
  readonly #guard: ScopeGuard<'background-tasks'>;
  readonly #registry: TaskRegistry;
  readonly #sessions: Pick<SessionRegistry, 'get'>;
  readonly #owned = new Set<TaskId>();
  readonly #observers = new Set<TaskObserver>();
  /**
   * Events heard and not yet delivered, in the order heard. While a `start` of this scope runs
   * they wait for its id (the registry announces a task before it returns it), and are then
   * delivered or dropped by ownership: a task is owned only by the id its own `start` returned,
   * never by timing. They also wait while an observer is being called, so what an observer
   * causes (a nested `start`) is heard after the events already queued, never before.
   */
  readonly #queue: Parameters<TaskObserver>[0][] = [];
  #starting = 0;
  #draining = false;

  constructor(params: {
    guard: ScopeGuard<'background-tasks'>;
    registry: TaskRegistry;
    sessions: Pick<SessionRegistry, 'get'>;
  }) {
    this.#guard = params.guard;
    this.#registry = params.registry;
    this.#sessions = params.sessions;
    this.#guard.track(
      this.#registry.observe((event) => {
        this.#queue.push(event);
        this.#drain();
      }),
    );
    Object.freeze(this);
  }

  start: BackgroundTaskScope['start'] = (given) => {
    this.#guard.enter('start');
    requireOpenSession({
      sessions: this.#sessions,
      id: given.sessionId,
      refused: 'work cannot start for it',
    });

    // Which session a task runs is for the harness's own sub-agent tool to say: an extension that
    // named one could take its node, and have the loop release it with the task, though it did
    // not start it. Its work is paired with no session.
    const { agentSessionId: _named, ...work } = given;

    this.#starting++;

    try {
      const info = startWork({ tasks: this.#registry, work });

      this.#owned.add(info.id);

      return info;
    } finally {
      this.#starting--;
      this.#drain();
    }
  };

  get: BackgroundTaskScope['get'] = (id) => {
    this.#guard.enter('get');

    return this.#owned.has(id) ? this.#registry.get(id) : undefined;
  };

  report: BackgroundTaskScope['report'] = (id) => {
    this.#guard.enter('report');

    return this.#owned.has(id) ? this.#registry.report(id) : undefined;
  };

  list: BackgroundTaskScope['list'] = () => {
    this.#guard.enter('list');

    return this.#registry.list().filter((task) => this.#owned.has(task.id));
  };

  observe: BackgroundTaskScope['observe'] = (observer) => {
    this.#guard.enter('observe');

    this.#observers.add(observer);

    return this.#guard.track(() => {
      this.#observers.delete(observer);
    });
  };

  cancel: BackgroundTaskScope['cancel'] = async (id) => {
    this.#guard.enter('cancel');

    if (!this.#owned.has(id)) return undefined;

    return await this.#registry.cancel(id);
  };

  group: BackgroundTaskScope['group'] = (params) => {
    this.#guard.enter('group');

    for (const id of params.ids) {
      if (this.#owned.has(id)) continue;

      throw new TaskError({ reason: 'unknown_task', taskId: id, message: missingTaskMessage(id) });
    }

    this.#registry.group(params);
  };

  /** Delivers the queue in order, unless a `start` is running or an outer drain is already at it. */
  #drain(): void {
    if (this.#starting > 0 || this.#draining) return;

    this.#draining = true;

    try {
      for (let event = this.#queue.shift(); event; event = this.#queue.shift()) {
        this.#deliver(event);
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * One event to every observer if its task is owned. An observer that throws never stops the
   * others, the queue or the `start` it runs under: its error is rethrown on its own, after this
   * call, so it still fails loudly as an uncaught error, as a registry listener's does.
   */
  #deliver(event: Parameters<TaskObserver>[0]): void {
    if (!this.#owned.has(event.update.task.id)) return;

    for (const observer of [...this.#observers]) {
      try {
        observer(event);
      } catch (caughtError) {
        queueMicrotask(() => {
          throw caughtError;
        });
      }
    }
  }
}
