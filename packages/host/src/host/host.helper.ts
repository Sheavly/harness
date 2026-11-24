import type { Provider } from '@sheavly/core/provider/provider.types';
import { ApprovalRegistry } from '@sheavly/runtime/approvals/approvals.service';
import { NodeChannelWriter } from '@sheavly/runtime/nodes/node-channel-writer.service';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import type { Harness, HarnessOptions } from './host.types.js';
import { SystemPrompt } from '../instructions/system-prompt.service.js';

/**
 * The services one run shares, for any LLM project: the provider the UI picked (seen by
 * `onModelCall` on every call, main session and sub-agents alike) and the session, task and
 * approval registries. It adds no tools and no hooks: the UI composes those from the packages'
 * factories (`createTaskTools`, `createSubAgentTool`, a coding UI's file tools) on these services.
 */
export function createHarness(options: HarnessOptions): Harness {
  const { title, onModelCall } = options;
  const systemPrompt = new SystemPrompt({
    baseInstructions: options.baseInstructions,
    instructions: options.instructions,
    omitInstructionSections: options.omitInstructionSections,
  });
  const provider: Provider = onModelCall
    ? {
        stream: (request) => {
          onModelCall(request);

          return options.provider.stream(request);
        },
        // Read through on every call: a switch answers for whichever model is active.
        get contextWindow() {
          return options.provider.contextWindow;
        },
      }
    : options.provider;
  const sessions = new SessionRegistry({
    ...(options.entries && { store: options.entries }),
    ...(options.resume && { resume: options.resume }),
  });
  const mainSession = sessions.restoredMain() ?? sessions.startMain({ title: title.slice(0, 60) });
  const approvals = options.approvals ?? new ApprovalRegistry();
  const tasks = options.tasks ?? new TaskRegistry(sessions.nodeOwners);
  // Now that the main session exists, and a reopened conversation's nodes are back, so the writer
  // sees every node that is open.
  const nodeChannels = options.channels
    ? NodeChannelWriter.attach({ nodes: sessions.nodes, tasks, storage: options.channels })
    : undefined;

  // Approvals and background tasks join the combined stream, in order with the events of the
  // call that asked or started them.
  approvals.observe((update) => sessions.publishApproval(update));
  tasks.observe((task) => sessions.publishTask(task));
  // An ended session can no longer be asked for anything: its open approvals end with it. Cancelled
  // here, not at release, while they are still kept under it, so each cancel lands in its stream.
  sessions.subscribe((update) => {
    if (update.type === 'session_ended') approvals.cancelSession(update.session.id);
  });

  return {
    provider,
    // Read at use: the extensions contribute after this harness exists.
    get instructions() {
      return systemPrompt.text;
    },
    systemPrompt,
    sessions,
    mainSession,
    tasks,
    nodes: sessions.nodes,
    ...(nodeChannels && { nodeChannels }),
    approvals,
  };
}
