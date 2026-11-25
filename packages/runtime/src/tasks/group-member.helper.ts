import type { TaskId } from '@sheavly/protocol/task/task.types';
import { TaskError } from '../errors/tasks.errors.js';
import { isFiniteKind } from './work.utils.js';
import { missingTaskMessage } from './tasks.utils.js';
import type { Entry } from './tasks.types.js';

/** The refusal for an id the caller has no task for: never issued, released or another session's. */
export function unknownTaskError(id: TaskId): TaskError {
  return new TaskError({ reason: 'unknown_task', taskId: id, message: missingTaskMessage(id) });
}

/** The error that keeps a task out of a new group, or undefined when it may join. */
function groupMemberError(params: {
  id: TaskId;
  duplicate: boolean;
  grouped: boolean;
  service: boolean;
  owned: boolean;
  delivered: boolean;
}): TaskError | undefined {
  const { id, duplicate, grouped, service, owned, delivered } = params;

  if (duplicate) {
    return new TaskError({ reason: 'duplicate_task', taskId: id, message: `Duplicate task ${id}` });
  }

  // Ownership before anything about the task itself, and the same answer as an id that does not
  // exist, so a foreign task's existence, group or kind is not revealed by the error.
  if (!owned) return unknownTaskError(id);

  if (grouped) {
    return new TaskError({
      reason: 'task_grouped',
      taskId: id,
      message: `Task ${id} already belongs to a group`,
    });
  }

  // A service may outlive the run, so a group waiting on it might never be delivered.
  if (service) {
    return new TaskError({
      reason: 'service_task',
      taskId: id,
      message: `Task ${id} is a service and cannot be awaited in a group`,
    });
  }

  // Finished work reaches the model once, so a delivered notice cannot be asked for again.
  if (delivered) {
    return new TaskError({
      reason: 'task_delivered',
      taskId: id,
      message: `Task ${id} was already reported and cannot be grouped`,
    });
  }

  return undefined;
}

/**
 * Throws what keeps task `id`, whose entry is `entry`, out of a group that already holds `seen`:
 * `owned` is whether the asking session may see it at all (`groupMemberError` says the rest).
 */
export function assertGroupMember(params: {
  id: TaskId;
  seen: ReadonlySet<TaskId>;
  entry: Entry;
  owned: boolean;
}): void {
  const { id, seen, entry, owned } = params;
  const error = groupMemberError({
    id,
    duplicate: seen.has(id),
    grouped: entry.group !== undefined,
    service: !isFiniteKind(entry.backgroundKind),
    owned,
    delivered: entry.delivery?.delivered === true,
  });

  if (error) throw error;
}
