import type { CallId } from '@sheavly/protocol/message/message.types';
import type { ChatItem } from '../client/transcript.types.js';

/**
 * The tool call an item of the main agent's channel names: the first thing it shows of the call
 * (it started, it is a task now, its result), or that its result was too large to store. None for
 * any other item.
 */
export function callNamedBy(item: ChatItem): CallId | undefined {
  if (item.type === 'event_omitted') return item.call?.id;

  if (item.type !== 'event') return undefined;

  const { event } = item;

  return event.type === 'tool_call_started' ||
    event.type === 'task_running' ||
    event.type === 'tool_result'
    ? event.call.id
    : undefined;
}

/** Whether `item` is the main agent's run ending. */
export const endsRun = (item: ChatItem): boolean =>
  item.type === 'event' && item.event.type === 'done';
