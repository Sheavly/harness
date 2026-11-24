import type { ModelConnection } from '@sheavly/protocol/connection/connection.types';
import type {
  ReasoningItem,
  ToolCall,
  TurnStopReason,
} from '@sheavly/protocol/message/message.types';
import type { ModelUsage } from '@sheavly/protocol/usage/usage.types';

// --- What a provider streams back ---

/** Why the model ended a turn (a turn the run's signal aborted is `interrupted` instead). */
export type StopReason = Exclude<TurnStopReason, 'interrupted'>;

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'reasoning'; item: ReasoningItem }
  /**
   * The model started (`active: true`) or stopped reasoning, as the provider can observe it.
   * Carries no reasoning content and is never kept in history; `reasoning` holds replay state.
   * Providers emit it live, may repeat a value, and send nothing when they can't observe it.
   */
  | { type: 'reasoning_activity'; active: boolean }
  /**
   * The call is waiting for the network or retrying an unreachable provider, as the provider can
   * observe it; `restored` ends either. Sent before anything of the reply, never kept in history.
   */
  | { type: 'model_connection'; connection: ModelConnection }
  | { type: 'done'; stopReason: StopReason; usage?: ModelUsage };
