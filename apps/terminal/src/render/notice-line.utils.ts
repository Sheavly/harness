import type { Look, NoticeEvent } from './render.types.js';
import { firstLine } from './render.utils.js';
import { plainTerminalText } from './terminal-text.utils.js';

/**
 * The line a loop event says that needs no state of the renderer: a steer, what a hook did to the
 * model's input, a summary, a hook that failed, the end of a turn. `''` is a look choosing to show
 * nothing.
 */
export function noticeLine(params: { look: Look; event: NoticeEvent }): string {
  const { look, event } = params;

  switch (event.type) {
    case 'message_received':
      return look.steer(firstLine(event.message.content));
    case 'context_added':
      return look.contextAdded({
        hook: plainTerminalText(event.hook),
        chars: event.content.length,
      });
    case 'model_input_changed':
      return look.modelInputChanged({
        hook: plainTerminalText(event.hook),
        added: event.added,
        removed: event.removed,
        edited: event.edited,
      });
    case 'summary_started':
      return look.summaryStarted();
    case 'summary_done':
      return look.summaryDone({
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
      });
    case 'summary_failed':
      return look.summaryFailed({
        error: firstLine(event.error),
        cancelled: event.kind === 'cancellation',
      });
    case 'hook_failed':
      return look.hookFailed({
        hook: plainTerminalText(event.hook),
        handler: event.handler,
        error: plainTerminalText(event.error),
      });
    case 'turn_end':
      return look.turnEnd({ stopReason: event.stopReason });
  }
}
