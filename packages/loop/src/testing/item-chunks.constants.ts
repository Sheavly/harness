import type { StreamEvent } from '@sheavly/core/message/message.types';

/** The last chunk of a model call that ended its turn. */
export const END_TURN: StreamEvent = { type: 'done', stopReason: 'end_turn' };

/** The last chunk of a model call that asked for tools. */
export const TOOL_USE: StreamEvent = { type: 'done', stopReason: 'tool_use' };

/** The model's reasoning, whole, as the Messages mapping sends it when the reply ends. */
export const REASONING_CHUNK: StreamEvent = {
  type: 'reasoning',
  item: { source: 'test:model', data: { opaque: 'state' } },
};
