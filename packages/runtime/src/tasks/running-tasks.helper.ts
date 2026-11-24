import type { RunningTask } from '@sheavly/protocol/notice/notice.types';
import type { Delivery, Entry } from './tasks.types.js';
import { runningTaskOf } from './tasks.utils.js';
import { isFiniteKind } from './work.utils.js';

/**
 * Whether finite work `owns` lets through is still running, or a group of the caller's still waits
 * to be delivered. A service never counts: it may run on past the run.
 */
export function hasPendingFiniteWork(params: {
  entries: Iterable<Entry>;
  owns: (entry: Entry) => boolean;
  ownsDelivery: (delivery: Delivery) => boolean;
}): boolean {
  const { entries, owns, ownsDelivery } = params;

  return [...entries].some(
    (entry) =>
      owns(entry) &&
      isFiniteKind(entry.backgroundKind) &&
      (entry.info.status === 'running' ||
        (entry.group !== undefined && !entry.group.delivered && ownsDelivery(entry.group))),
  );
}

/**
 * How many running members of groups whose notice is not yet delivered the caller owns: the tasks a
 * run holds for when it waits on `await_tasks`. Ungrouped tasks do not count.
 */
export function groupedPendingOf(params: {
  entries: Iterable<Entry>;
  ownsDelivery: (delivery: Delivery) => boolean;
}): number {
  const { entries, ownsDelivery } = params;

  return [...entries].filter(
    ({ info, group }) =>
      info.status === 'running' && group !== undefined && !group.delivered && ownsDelivery(group),
  ).length;
}

/**
 * Fresh metadata-only snapshots of the running tasks `owns` lets through, in start order. A group's
 * first id is given only when `ownsDelivery` says the caller owns every member, so a group that
 * reaches into another session shows its tasks with their descriptions and nothing of the group.
 * Each group's ownership is checked once, not once per running member.
 */
export function runningTasksOf(params: {
  entries: Iterable<Entry>;
  owns: (entry: Entry) => boolean;
  ownsDelivery: (delivery: Delivery) => boolean;
}): RunningTask[] {
  const { entries, owns, ownsDelivery } = params;
  const visibility = new Map<Delivery, boolean>();

  return [...entries]
    .filter((entry) => entry.info.status === 'running' && owns(entry))
    .map((entry) => {
      const { info, group } = entry;

      if (group && !visibility.has(group)) visibility.set(group, ownsDelivery(group));

      return runningTaskOf({
        info,
        group: group && visibility.get(group) ? group.ids[0] : undefined,
      });
    });
}
