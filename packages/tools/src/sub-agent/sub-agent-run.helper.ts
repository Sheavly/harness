import { randomUUID } from 'node:crypto';
import { now } from '@sheavly/core/clock/clock.helper';
import { escapedLine, escapeTags } from '@sheavly/core/text/text.utils';
import type { Tool } from '@sheavly/core/tool/tool.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { messageIdSchema } from '@sheavly/protocol/message/message.validator';
import type { SessionRef } from '@sheavly/protocol/session/session.types';
import { SubAgentStoppedError } from '../errors/sub-agent.errors.js';
import { SUB_AGENT_INSTRUCTIONS } from './sub-agent.prompt.js';
import type { SubAgentOptions } from './sub-agent.types.js';
import { finalReply, subAgentInstructions } from './sub-agent.utils.js';

/**
 * Runs the sub-agent's loop to its end and returns its report, whole. Its status and steering
 * lines go into the task's output preview, never into the report. `tools` are what the sub-agent
 * gets, built by the caller when the run starts. Keeping the history before and after the run,
 * and stopping the child's own tasks (its parent's and siblings' share the registry) when it
 * ends, belong to `children.runChild`.
 */
export async function runSubAgent(params: {
  options: SubAgentOptions;
  child: SessionRef;
  task: string;
  tools: Tool[];
  signal: AbortSignal;
  onOutput: (chunk: string) => void;
}): Promise<{ exitCode: number; report: string }> {
  const { options, child, task, tools, signal, onOutput } = params;
  const { provider, hooks = [], instructions, keepHistory } = options;
  const { children } = options.scopes;
  const summary = options.summarizeWith?.(provider);
  const stopListening = children.onUpdate((update) => {
    if (update.session.id !== child.id) return;

    // These lines reach the parent as the task's output, and what a sub-agent reports about itself
    // or is sent is written by a model or an extension: a status is one line, a message keeps its
    // line breaks, and neither may carry a tag that closes the parent's envelope.
    if (update.type === 'session_status') {
      onOutput(`[status] ${escapedLine(update.session.status ?? '')}\n`);
    }

    if (update.type === 'session_message') {
      onOutput(`[message] ${escapeTags(update.message.content)}\n`);
    }
  });

  // An id marks the one message the sub-agent's own work is asked for: the agent that started
  // it wrote the task, and no one else can message a sub-agent as a user.
  const first: HistoryMessage[] = [
    { role: 'user', id: messageIdSchema.parse(randomUUID()), content: task, at: now() },
  ];

  try {
    const { reason, messages } = await children.runChild({
      child,
      provider,
      tools,
      hooks,
      instructions: subAgentInstructions({
        base: options.baseInstructions,
        rules: SUB_AGENT_INSTRUCTIONS,
        extra: instructions,
      }),
      messages: first,
      ...(keepHistory && {
        keepHistory: (kept: readonly HistoryMessage[]) =>
          keepHistory({ session: child.id, messages: kept }),
      }),
      signal,
      onRunEnd: stopListening,
      ...(summary && { summary }),
    });

    // A run that did not finish has no report: its last message is work in progress. Throwing
    // fails the task with the reason, so the parent is told it failed and why, not handed text.
    if (reason !== 'completed') {
      throw new SubAgentStoppedError({ reason });
    }

    const report = finalReply(messages);

    // The preview keeps the report's end for a UI that shows a card; the parent is handed `report`.
    onOutput(`\n${report}`);

    return { exitCode: 0, report };
  } finally {
    stopListening();
  }
}
