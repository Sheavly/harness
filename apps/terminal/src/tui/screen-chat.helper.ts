import { TuiMainScreen } from '@earendil-works/pi-tui';
import { answerWhileWaiting } from '@sheavly/client/approvals/approvals.helper';
import type { ApprovalId } from '@sheavly/protocol/approval/approval.types';
import type { ConversationDetails } from '@sheavly/protocol/server/server.types';
import { ChatSession } from '../chat/chat-session.service.js';
import { describeFailure } from '../render/terminal-text.utils.js';
import { TerminalBell } from '../bell/bell.service.js';
import { UsageLedger } from '@sheavly/runtime/usage/usage.service';
import { ContextUsageTracker } from '../usage/context-usage.service.js';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import { ScrollbackTerminal } from './scrollback-terminal.service.js';
import type { AskedApproval } from '../client/client.types.js';
import type { RemoteConversation } from '../client/conversation.service.js';
import { configureHyperlinks, createFileLinker } from '../links/links.helper.js';
import { createChatLook } from '../render/chat-look.utils.js';
import { Renderer } from '../render/render.service.js';
import { ReactView } from '../react-screen/react-view.service.js';
import { paletteFromEnv } from '../theme/theme.helper.js';
import { createClassicView } from './classic-view.helper.js';
import { ChatScreen } from './chat-screen.service.js';
import type { RunState } from '../chat/chat.types.js';
import type { ApprovalAnswer, ScreenChat, StatusInfo } from './tui.types.js';

/**
 * Runs the chat on the terminal's main screen: the conversation's text and the approvals it asks
 * for, an editor that sends follow-ups while it works, and a status line. Starts listening
 * for approvals before it takes any line, so the first command that needs one waits for the user
 * instead of being refused.
 *
 * `firstPrompt` is sent as soon as the screen is up. The caller prints its own startup lines
 * before this, so they stay above the screen in the scrollback.
 */
export async function startScreenChat(params: {
  conversation: RemoteConversation;
  details: ConversationDetails;
  skills: { name: string; description?: string }[];
  firstPrompt: string | undefined;
  reducedMotion?: boolean;
  bell?: boolean;
}): Promise<ScreenChat> {
  const { conversation, details, firstPrompt } = params;
  // Before anything is drawn: a theme that doesn't exist fails here, with the ones there are.
  const palette = paletteFromEnv(process.env);

  configureHyperlinks(process.env);

  const watching = new AbortController();
  const usage = new UsageLedger(details.usage);
  const context = new ContextUsageTracker(details.session, details.contextUsage);
  const status = {
    state: 'ready' as const,
    model: details.model.name,
    modelEffort: details.model.effort ?? 'medium',
    mode: details.permissionMode,
    ...branchOf(details),
    tasks: 0,
    usage: usage.snapshot,
    contextUsage: context.snapshot,
  };
  const editorOptions = {
    commands: [...ChatScreen.commands, ...params.skills],
    cwd: details.workspace,
    palette,
  };
  const terminal = new ScrollbackTerminal();
  const bell = new TerminalBell({
    enabled: params.bell ?? false,
    write: (text) => terminal.write(text),
  });
  const view =
    process.env.SHEAVLY_TUI === 'classic'
      ? createClassicView({ ...editorOptions, tui: new TuiMainScreen(terminal) })
      : new ReactView({
          ...editorOptions,
          terminal,
          status,
          reducedMotion: params.reducedMotion ?? false,
        });
  const screen: ChatScreen = new ChatScreen({
    view,
    status,
    ...editorOptions,
    onSubmit: (line) => session.submit(line),
    onStop: () => {
      bell.finishTurn();

      return session.stop();
    },
    onAnswer: (answer) => void answerApproval({ conversation, screen, answer }),
    onQuit: () => leave(),
    onExpand: () => session.describeLatest(),
  });
  const renderer = new Renderer(screen.write, createChatLook(palette), screen.reply);
  const keepUsage = (entry: StreamEntry) => {
    usage.observe(entry);
    context.observe(entry);
    screen.setStatus({ usage: usage.snapshot, contextUsage: context.snapshot });
  };
  let leave: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => (leave = resolve));
  const session: ChatSession = new ChatSession({
    conversation,
    renderer,
    mainSession: details.session,
    write: screen.write,
    columns: () => view.columns,
    palette,
    linkFile: createFileLinker({ root: details.workspace, env: process.env }),
    onSend: (text) => {
      bell.startTurn();
      screen.echo(text);
    },
    onReplyComplete: () => bell.replyCompleted(),
    onTurnEnd: (outcome) => {
      bell.finishTurn();
      screen.endTurn(outcome);
    },
    onQueue: (queue) => {
      screen.setQueue(queue);
      screen.setStatus({ queued: queue.length });
    },
    onTools: (tools) => {
      bell.watchTools(tools);
      screen.setStatus({ tools });
    },
    onThinking: (thinking) => screen.setStatus({ thinking }),
    onRunState: (run) => screen.setStatus(statusOfRun(run)),
    onUsage: keepUsage,
    onBusy: (busy) => {
      screen.setStatus({ state: busy ? 'working' : 'ready', ...(busy ? {} : { thinking: false }) });

      if (!busy) {
        void conversation
          .details()
          .then((details) => {
            if (details.usage) usage.update(details.usage);
            if (details.contextUsage) context.update(details.contextUsage);
            screen.setStatus({
              model: details.model.name,
              modelEffort: details.model.effort ?? 'medium',
              // Cleared when the root was, so the badge never outlives it.
              workingBranch: branchOf(details).workingBranch,
              usage: usage.snapshot,
              contextUsage: context.snapshot,
            });
          })
          .catch((caughtError: unknown) =>
            screen.notice(`Could not refresh model: ${describeFailure(caughtError)}`),
          );
      }
    },
    onExit: () => leave(),
  });

  // The approvals come from the conversation's tree. Usage no longer comes with them: the live
  // stream below delivers every session's usage, between prompts too.
  const { ended } = await conversation.watchApprovals({
    onApproval: (asked) => askApproval({ asked, screen, bell }),
    onGone: (id) => forgetApproval({ id, screen, bell }),
    signal: watching.signal,
  });

  void ended.catch((caughtError: unknown) => {
    screen.notice(`✗ lost the approval stream: ${describeFailure(caughtError)}`);
  });

  // Every run's output comes here: the user's lines, and the runs the backend starts itself.
  const followed = await conversation.follow({
    onEntry: (entry) => session.hear(entry),
    signal: watching.signal,
  });

  void followed.ended.catch((caughtError: unknown) => session.lostStream(caughtError));

  // The status line's counts of background work come from the conversation's tree.
  const background = await conversation.watchBackground({
    listener: (counts) => screen.setStatus(counts),
    signal: watching.signal,
  });

  void background.ended.catch((caughtError: unknown) => {
    screen.notice(`✗ lost the background status: ${describeFailure(caughtError)}`);
  });

  screen.start();
  // Lines queued before a restart are shown as waiting and not sent: reopening never runs them.
  session.restoreQueued(await conversation.queue());
  if (firstPrompt) session.submit(firstPrompt);

  return {
    finished: view instanceof ReactView ? Promise.race([finished, view.finished]) : finished,
    stop: async () => {
      bell.stop();
      watching.abort();
      // Leaving drops the lines waiting, however the user left (`/exit`, Ctrl+D, Ctrl+C).
      await session.dropQueued();
      session.stop();
      screen.stop();
    },
  };
}

/**
 * What the status line says for a held run: waiting on grouped tasks, `ready` when none are
 * grouped (a line sent now starts once the model has finished), `working` once it runs again.
 */
export function statusOfRun(
  run: RunState,
): Pick<StatusInfo, 'state' | 'awaitedTasks' | 'thinking'> {
  if (run.state === 'working') return { state: 'working' };
  // Not working, so a stale "thinking..." must not return with the next turn.
  if (run.groupedTasks === 0) return { state: 'ready', thinking: false };

  return { state: 'awaiting_tasks', awaitedTasks: run.groupedTasks, thinking: false };
}

/** The branch to show for the working root: its name, or "detached HEAD"; none without a root. */
function branchOf(details: ConversationDetails): { workingBranch?: string } {
  const { workingRoot } = details;

  if (!workingRoot) return {};

  return { workingBranch: workingRoot.branch ?? 'detached HEAD' };
}

/** An approval that was asked appears on the screen, with the sub-agent that asked it. */
function askApproval(params: {
  asked: AskedApproval;
  screen: ChatScreen;
  bell: TerminalBell;
}): void {
  const { asked, screen, bell } = params;

  screen.ask(asked.request, asked.asker);
  bell.requestApproval(asked.request.id);
}

/** An approval that no longer waits (answered here or elsewhere, or given up) disappears. */
function forgetApproval(params: { id: ApprovalId; screen: ChatScreen; bell: TerminalBell }): void {
  const { id, screen, bell } = params;

  screen.forget(id);
  bell.forgetApproval(id);
}

/**
 * Sends the user's answer. One already answered elsewhere (`unknown_approval`) is not a failure:
 * the screen has been told it is gone. Anything else is shown, and the command that waited is
 * left to the backend, which refuses what nobody answers when the prompt ends.
 */
async function answerApproval(params: {
  conversation: RemoteConversation;
  screen: ChatScreen;
  answer: ApprovalAnswer;
}): Promise<void> {
  const { conversation, screen, answer } = params;

  try {
    await answerWhileWaiting(() =>
      conversation.answerApproval({ approval: answer.id, response: answer.response }),
    );
  } catch (caughtError) {
    screen.notice(`✗ could not send your answer: ${describeFailure(caughtError)}`);
  }
}
