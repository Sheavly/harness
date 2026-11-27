import type {
  ApprovalId,
  ApprovalOption,
  ApprovalResponse,
} from '@sheavly/protocol/approval/approval.types';
import type { PermissionMode } from '@sheavly/protocol/permission/permission.types';
import type { ModelEffort } from '@sheavly/protocol/model/model.types';
import type { RunningTool } from '../render/render.types.js';
import type { ContextFill, UsageFigures } from '@sheavly/protocol/usage/usage.types';

/** One thing the user can answer an approval with, as the prompt lists it. */
export type ApprovalChoice = { option: ApprovalOption; label: string; hint: string };

/** An answer to send: which approval, and the decision. */
export type ApprovalAnswer = { id: ApprovalId; response: ApprovalResponse };

/** Where the prompt is: choosing among the options, or typing what to tell the model instead. */
export type ApprovalPhase = 'choose' | 'message';

/** What confirming a choice led to. */
export type ApprovalOutcome =
  { kind: 'answer'; answer: ApprovalAnswer } | { kind: 'needs_message' } | { kind: 'none' };

/** What a running screen chat gives back: wait for it to end, and end it. */
export type ScreenChat = {
  /** Resolves when the user left (`/exit`, or Ctrl+C twice). */
  finished: Promise<void>;
  /** Stops what the chat started on the backend and leaves the terminal as it was. */
  stop: () => Promise<void>;
};

/** What the line under the conversation says. */
export type StatusInfo = {
  /**
   * `waiting` is for the user's approval; `awaiting_tasks` is the run held open for the
   * `awaitedTasks` tasks the agent grouped, with no spinner.
   */
  state: 'ready' | 'working' | 'waiting' | 'awaiting_tasks';
  /** Grouped tasks the held run still waits on; only read in `awaiting_tasks`. */
  awaitedTasks?: number;
  /** Lines waiting in the backend's queue; none when absent. */
  queued?: number;
  model: string;
  modelEffort?: ModelEffort;
  mode: PermissionMode;
  /**
   * The branch of the folder the agents work in, once they chose one: shown once here so paths
   * need not repeat the worktree. A detached HEAD shows as its own label.
   */
  workingBranch?: string | undefined;
  /** Background commands still running. */
  tasks: number;
  /** Background sub-agents still running; none when absent. */
  agents?: number;
  /** Background services still running; none when absent. */
  services?: number;
  /** Tool calls the prompt waits on now, which a screen that can animate shows with their time. */
  tools?: readonly RunningTool[];
  /** The model signalled reasoning; only shown while working, never claimed without a signal. */
  thinking?: boolean;
  /** The figures of every model call, as the backend counts them. */
  usage?: UsageFigures;
  /** How full the main agent's context is; none before its first call. */
  context?: ContextFill | undefined;
};
