import { createInterface } from 'node:readline/promises';
import { stripVTControlCharacters } from 'node:util';
import type { ConversationDetails } from '@sheavly/protocol/server/server.types';
import { ChatSession } from './chat-session.service.js';
import { completeChatLine } from './chat.utils.js';
import { followTranscript } from './follow-transcript.helper.js';
import type { RemoteConversation } from '../client/conversation.service.js';
import { interruptOnCtrlC } from '../interrupt/interrupt.helper.js';
import type { Renderer } from '../render/render.service.js';

/**
 * Runs the chat as lines in and lines out, for input that is not a terminal (piped, scripted) and
 * for a terminal that cannot run the screen. Approvals are not answered here: a command that
 * needs one is refused and the model told, as there is no one to ask.
 *
 * Returns when the user left: `/exit`, Ctrl+D, the end of piped input once its lines have run,
 * or Ctrl+C at the input line. `stopTasks` is called with the number of background tasks still
 * running at that point.
 */
export async function runLineChat(params: {
  conversation: RemoteConversation;
  details: ConversationDetails;
  renderer: Renderer;
  write: (text: string) => void;
  firstPrompt: string | undefined;
  /** Ends the conversation and its backend when a second, deliberate Ctrl+C asks to leave. */
  forceQuit: () => Promise<void>;
  /** Exits the process after `forceQuit`; the process's own unless a test stands in. */
  exit?: (code: number) => void;
}): Promise<void> {
  const { conversation, details, renderer, write, firstPrompt, forceQuit, exit } = params;

  if (details.models.length > 0) {
    write(
      `→ models: ${details.models.map(({ name }) => name).join(', ')} (/model <name> to switch)\n`,
    );
  }

  write('→ /help for help, /exit or Ctrl+D to quit\n\n');

  // Tab after `/` completes skill names (read fresh, so a new skill is offered at once) and commands.
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: async (before: string) =>
      completeChatLine({ before, skills: await conversation.skills() }),
  });
  // Read lines from the start, so lines typed (or piped in) while the first prompt runs are kept;
  // readline only listens once its iterator exists.
  const lines = input[Symbol.asyncIterator]();
  let inputOpen = true;
  let quitting = false;

  input.once('close', () => (inputOpen = false));

  const session: ChatSession = new ChatSession({
    conversation,
    renderer,
    // Line mode is plain text: what `/changes` prints is styled for the screen, so drop that.
    write: (text) => write(stripVTControlCharacters(text)),
    onExit: () => {
      quitting = true;
      input.close();
    },
  });

  // readline owns Ctrl+C while it reads, so it is the signal source here, not `process`.
  const ctrlC = interruptOnCtrlC({
    write,
    source: input,
    stop: () => session.stop(),
    onIdle: () => {
      quitting = true;
      input.close();
    },
    forceQuit: () => {
      quitting = true;

      return forceQuit();
    },
    ...(exit && { exit }),
  });

  const following = new AbortController();

  try {
    // Every run's output comes through the feed, so losing it ends what was running.
    await followTranscript({ conversation, session, signal: following.signal });

    if (firstPrompt) session.submit(firstPrompt);

    input.setPrompt('› ');
    if (inputOpen) input.prompt();

    // Keep reading during a run: commands run at once and prompts go to the backend's queue.
    for (let next = await lines.next(); !next.done && !quitting; next = await lines.next()) {
      session.submit(next.value);
      if (quitting) break;
      if (inputOpen) input.prompt();
    }

    // EOF ends input, not the lines already sent: the backend runs them, and the chat waits.
    await session.idle();
  } finally {
    ctrlC.dispose();
    following.abort();
    input.close();
  }
}
