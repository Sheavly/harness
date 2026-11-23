import type { RunningTask } from '@sheavly/protocol/notice/notice.types';
import type { Delivery, Entry } from './tasks.types.js';
import { runningTaskOf } from './tasks.utils.js';

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
