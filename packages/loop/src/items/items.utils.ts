import { ConnectionLostError } from '@sheavly/core/errors/connection.errors';
import { MAX_OMITTED_CALL_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { MAX_ITEM_DESCRIPTION_CHARS } from '@sheavly/protocol/item/item.constants';
import type { Item, ItemEvent, ItemId } from '@sheavly/protocol/item/item.types';
import type { ToolCall, TurnStopReason } from '@sheavly/protocol/message/message.types';
import { HIGH_SURROGATES, LOW_SURROGATES } from './items.constants.js';
import type { ItemReason, ToolItemSource } from './items.types.js';

const isHighSurrogate = (unit: number) =>
  unit >= HIGH_SURROGATES.first && unit <= HIGH_SURROGATES.last;

const isLowSurrogate = (unit: number) =>
  unit >= LOW_SURROGATES.first && unit <= LOW_SURROGATES.last;

/**
 * Splits `text` after at most `room` UTF-16 code units, one unit earlier when the cut would fall
 * inside a surrogate pair, so neither part holds half of one. `head` is all of `text` when it fits.
 */
export function splitForRoom(params: { text: string; room: number }): {
  head: string;
  rest: string;
} {
  const { text, room } = params;

  if (text.length <= room) return { head: text, rest: '' };

  const inPair =
    isHighSurrogate(text.charCodeAt(room - 1)) && isLowSurrogate(text.charCodeAt(room));
  const cut = inPair ? room - 1 : room;

  return { head: text.slice(0, cut), rest: text.slice(cut) };
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
export function cutAtCodePoint(params: { text: string; max: number }): string {
  return splitForRoom({ text: params.text, room: params.max }).head;
}

/**
 * Takes a final high surrogate off `text`: it may be the first half of a pair whose second half
 * is the start of the next chunk, so it is `held` until then and is not part of `ready`.
 */
export function holdBack(text: string): { ready: string; held: string } {
  if (text !== '' && isHighSurrogate(text.charCodeAt(text.length - 1))) {
    return { ready: text.slice(0, -1), held: text.slice(-1) };
  }

  return { ready: text, held: '' };
}

/**
 * How a message ended: `interrupted` when the user stopped the run or the connection was lost
 * while it streamed, `failed` for any other failure of the model call or when the model said the
 * context window was exceeded (the call did not complete, and the loop may drop the reply and try
 * again), otherwise `completed`.
 */
export function messageReason(params: {
  signal: AbortSignal;
  failure: { error: unknown } | undefined;
  /** What the model said when it ended the call, before a failure changes it. */
  stopReason: TurnStopReason;
}): ItemReason {
  const { signal, failure, stopReason } = params;

  if (signal.aborted) return 'interrupted';

  if (!failure) return stopReason === 'context_window_exceeded' ? 'failed' : 'completed';

  return failure.error instanceof ConnectionLostError ? 'interrupted' : 'failed';
}

/**
 * What a tool call's item and its `item_started` both carry, cut to the bounds the schema holds.
 * The call's id is the provider's hint and has no bound of its own: it is left out when empty or
 * too long, never cut.
 */
function toolHeader(params: { call: ToolCall; description: string; turn: number }) {
  const { call, description, turn } = params;
  const usable = call.id !== '' && call.id.length <= MAX_OMITTED_CALL_CHARS;

  return {
    name: cutAtCodePoint({ text: call.name, max: MAX_OMITTED_CALL_CHARS }),
    description: cutAtCodePoint({ text: description, max: MAX_ITEM_DESCRIPTION_CHARS }),
    turn,
    ...(usable && { callId: call.id }),
  };
}

/** The `item_started` of a tool call: its header, never its input. */
export function toolStarted(params: {
  id: ItemId;
  call: ToolCall;
  description: string;
  turn: number;
}): ItemEvent {
  const { id, call, description, turn } = params;

  return {
    type: 'item_started',
    itemId: id,
    kind: 'tool_call',
    ...toolHeader({ call, description, turn }),
  };
}

/**
 * The completed item of a tool call: its header and input, and what became of it. A call that
 * launched a node has a `task` and no result; any other has the result its message holds, which
 * for a call that was stopped is the placeholder history holds too.
 */
export function completedTool(source: ToolItemSource): Item {
  const { id, described, turn, outcome, message, reason } = source;
  const { call, description } = described;
  const base = {
    kind: 'tool_call' as const,
    id,
    ...toolHeader({ call, description, turn }),
    input: call.input,
    reason,
  };

  if (outcome.type === 'task_running' && outcome.nodeId !== undefined) {
    const { task: info, nodeId, durationMs } = outcome;

    return { ...base, task: { info, nodeId, durationMs } };
  }

  const artifacts = outcome.type === 'tool_result' ? outcome.artifacts : undefined;

  return {
    ...base,
    result: {
      content: message.content,
      isError: message.isError,
      ...(artifacts && { artifacts }),
      durationMs: outcome.durationMs,
    },
  };
}
