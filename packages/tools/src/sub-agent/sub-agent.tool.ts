import { z } from 'zod';
import { defineTool } from '@sheavly/core/tool/tool.utils';
import { ToolCallError } from '@sheavly/core/errors/tool.errors';
import { MAX_SESSION_DEPTH } from '@sheavly/runtime/sessions/sessions.constants';
import { startWork } from '@sheavly/runtime/tasks/work.utils';
import { subAgentWork } from './sub-agent-work.utils.js';
import { runSubAgent } from './sub-agent-run.helper.js';
import { createTaskTools } from '../tasks/tasks.tool.js';
import { createReportStatusTool } from './report-status.tool.js';
import { createMessageAgentTool } from './message-agent.tool.js';
import { subAgentDescription, subAgentPrompts, startedSubAgentPrompt } from './sub-agent.prompt.js';
import type { SubAgentOptions } from './sub-agent.types.js';
import type { SessionRef } from '@sheavly/protocol/session/session.types';

/**
 * `options` with the provider the sub-agent was pinned to, still holding the live `tools` and
 * `hooks` of `options` (copied as descriptors, so a getter stays a getter): a `start_agent` the
 * sub-agent calls later reads what is shared at that call, not what was shared when it started.
 * Every descriptor is copied as configurable, so options the caller froze still work, as they did
 * when the options were spread.
 */
function pinProvider(params: {
  options: SubAgentOptions;
  selected: ReturnType<NonNullable<SubAgentOptions['selectProvider']>>;
}): SubAgentOptions {
  const { options, selected } = params;
  const original: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(options);
  const copied: PropertyDescriptorMap = {};

  for (const key of Reflect.ownKeys(original)) {
    copied[key] = { ...original[key], configurable: true };
  }

  const pinned = Object.defineProperties({}, copied);

  return Object.defineProperties(pinned, {
    provider: { value: selected.provider, enumerable: true, writable: true, configurable: true },
    selectProvider: {
      value: () => selected,
      enumerable: true,
      writable: true,
      configurable: true,
    },
  }) as SubAgentOptions;
}

/**
 * The tools a sub-agent at `child`'s depth gets: the parent's, `report_status`, and what its depth
 * allows. `own` is what this sub-agent was given (a snapshot); `nested` builds the `start_agent`
 * it can call, which takes its own snapshot at that call.
 */
function toolsFor(params: { own: SubAgentOptions; nested: SubAgentOptions; child: SessionRef }) {
  const { own, nested, child } = params;
  const { children, sessions, taskControl } = own.scopes;
  const canNest = child.depth < MAX_SESSION_DEPTH;

  return [
    ...own.tools,
    createReportStatusTool({ children }),
    // Background-capable tools need inspection, grouping and cancellation even at the depth cap.
    ...(canNest || own.withTaskTools ? createTaskTools(taskControl) : []),
    ...(canNest
      ? [createSubAgentTool(nested), createMessageAgentTool({ sessions, children })]
      : []),
  ];
}

/**
 * `start_agent`: starts a sub-agent, a nested agent loop on one task, as a background task of
 * the calling session. The sub-agent gets its own session (id, linked to the caller as parent),
 * its own `sessionStart`, the tools and hooks the parent chose, and `report_status`. Below the
 * depth cap it can start sub-agents of its own; at the cap (depth 3) it can't, and the session
 * registry refuses anyway. Its report, its final answer whole, comes back as the task's report.
 */
export function createSubAgentTool(options: SubAgentOptions) {
  const wiring = options.scopes;

  return defineTool({
    name: 'start_agent',
    description: subAgentDescription(MAX_SESSION_DEPTH),
    inputSchema: z.object({
      title: z.string().min(1).max(80).describe(subAgentPrompts.title),
      task: z.string().min(1).describe(subAgentPrompts.task),
    }),
    execute: async ({ input: { title, task }, context }) => {
      if (!context.session) {
        throw new ToolCallError({
          reason: 'unavailable',
          message: 'start_agent only works inside an agent session',
        });
      }

      // Throws for an unknown or ended parent, and at the depth cap: no session floats free.
      const child = wiring.children.startChild({
        parentId: context.session.id,
        startedByCall: context.callId,
        title,
      });
      const selected = options.selectProvider?.() ?? { provider: options.provider };

      if (selected.selection) {
        wiring.children.setModel({ id: child.id, ...selected.selection });
      }

      // Spreading reads the `tools` and `hooks` getters once: what this sub-agent runs with is
      // what was shared now, even if something is revoked while it runs.
      const childOptions = {
        ...options,
        provider: selected.provider,
        selectProvider: () => selected,
      };
      const nestedOptions = pinProvider({ options, selected });
      const started = startWork({
        tasks: wiring.tasks,
        work: subAgentWork({
          command: `sub-agent: ${title}`,
          description: context.description,
          callId: context.callId,
          sessionId: context.session.id,
          // The task and the child session are one node, paired by this id and never by the call
          // id, which a provider may repeat.
          agentSessionId: child.id,
          // The tools are built when the run starts, from the snapshot taken at this call; a
          // nested `start_agent` takes its own snapshot when it is called.
          run: ({ signal, onOutput }) =>
            runSubAgent({
              options: childOptions,
              child,
              task,
              tools: toolsFor({ own: childOptions, nested: nestedOptions, child }),
              signal,
              onOutput,
            }),
        }),
      });

      return startedSubAgentPrompt({
        title,
        taskId: started.id,
        sessionId: child.id,
        depth: child.depth,
      });
    },
  });
}
