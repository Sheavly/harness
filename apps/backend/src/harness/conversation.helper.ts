import { createConversation } from '@sheavly/host/conversation/conversation.helper';
import type {
  ConversationRun,
  ConversationSkills,
  ConversationStorage,
  LiveConversation,
} from '@sheavly/host/conversations/conversations.types';
import type { SummaryOptions } from '@sheavly/core/summary/summary.types';
import { streamAgent } from '@sheavly/loop/stream-agent/stream-agent.helper';
import type { Logger } from '@sheavly/logger/logger/logger.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { UnknownSkillError } from '@sheavly/coding/errors/skills.errors';
import { skillRequest } from '@sheavly/coding/skills/skill-files.helper';
import { findSkills } from '@sheavly/coding/skills/skills.helper';
import type { SkillRoots } from '@sheavly/coding/skills/skills.types';
import { LOG_EVENT } from '../logging/logging.constants.js';
import type { BackendHarness } from './harness.types.js';

/**
 * A workspace's skills as a conversation offers them: the list for a `/` menu, and each prompt
 * prepared by `skillRequest` (text mentions or picked parts). A picked skill no one has is
 * reported, not thrown, so the host refuses the prompt with `unknown_skill`.
 */
export function workspaceSkills(roots: SkillRoots): ConversationSkills {
  return {
    list: async ({ signal }) => {
      const { skills } = await findSkills({ ...roots, ...(signal && { signal }) });

      return skills.map(({ name, description, manualOnly, scope }) => ({
        name,
        description,
        manualOnly,
        scope,
      }));
    },
    prepare: async ({ prompt, signal }) => {
      try {
        const { text, parts } = await skillRequest({ ...roots, prompt, ...(signal && { signal }) });

        return { text, parts };
      } catch (caughtError) {
        if (caughtError instanceof UnknownSkillError) return { unknown: caughtError.skills };
        throw caughtError;
      }
    },
  };
}

/**
 * One conversation on a backend harness: its tools and hooks, the
 * workspace's skills, at most `maxTurns` turns a prompt (no limit without it). Finite background
 * tasks keep each prompt active; services may outlive it. Closing it stops its background commands. `messages` is
 * history to continue from, and `run` what the app says the run is, the model it is on included.
 */
export function harnessConversation(params: {
  harness: BackendHarness;
  run: ConversationRun;
  messages?: HistoryMessage[] | undefined;
  /** Where the host keeps this conversation (see `ConversationStorage`); none keeps nothing. */
  storage?: ConversationStorage | undefined;
  /** The conversation's logger: a run it starts for finished work has no caller to throw to. */
  logger: Logger;
  maxTurns?: number;
  /** Summarize the history when the context nears the window; none never does. */
  summary?: SummaryOptions | undefined;
}): LiveConversation {
  const { harness, run, messages, storage, logger, maxTurns, summary } = params;

  return {
    harness,
    conversation: createConversation({
      harness,
      run: streamAgent,
      tools: harness.tools,
      hooks: harness.hooks,
      // No caller iterates a run the conversation starts for finished work: the operator sees it.
      onWakeFailure: (caughtError) =>
        logger.error(LOG_EVENT.WAKE_RUN_FAILED, { error: caughtError }),
      ...(maxTurns !== undefined && { maxTurns }),
      ...(summary && { summary }),
      ...(messages && { messages }),
      ...(storage && {
        keepHistory: storage.keepHistory,
        // A reopened conversation's session already ran its `sessionStart` hooks.
        resumed: storage.resume !== undefined,
      }),
    }),
    skills: workspaceSkills(harness.skills),
    run,
  };
}
