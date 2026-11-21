/**
 * The terminal chat: one conversation you keep talking to, prompt after prompt, with its history,
 * background tasks and the commands they started kept alive in between, on the backend.
 *
 *   npm run dev -w @sheavly/terminal                       from source
 *   npm run start -w @sheavly/terminal                     built first, then plain Node
 *   npm run dev -w @sheavly/terminal -- "first message"    starts with that message
 *
 * (or `npm run dev` / `npm run start` inside apps/terminal).
 *
 * It starts its own backend with this environment's settings (apps/backend/docs/serve.md:
 * WORKSPACE_ROOT, SHOW_MODEL_CALLS, --trust) and runs on the models
 * in the user's profile (~/.sheavly), and stops it on the way out; BACKEND_URL and BACKEND_TOKEN
 * use one already running.
 *
 * On a terminal it is a screen (apps/terminal/docs/chat.md): the conversation scrolls up into the
 * terminal's own history, and a command that needs your say asks you. Without one (piped input,
 * or `SHEAVLY_PLAIN=1`) it reads lines and refuses what would need asking. Ctrl+C stops the
 * running prompt, /<skill> anywhere in a message runs that skill, /exit ends the conversation.
 * Calls the real API, so it costs money.
 */
import { reportChatFailure } from './chat/chat-failure.helper.js';
import { runTerminalChat } from './chat/start.helper.js';

// npm runs a workspace's script inside apps/terminal; work from the folder it was started in
// (npm's INIT_CWD), so the default workspace is the user's.
if (process.env.INIT_CWD) process.chdir(process.env.INIT_CWD);

try {
  await runTerminalChat();
} catch (caughtError) {
  reportChatFailure(caughtError);
}
