export const CHAT_NAME = 'chat';

export const CHAT_SUMMARY = 'Talk to the harness in the terminal';

/**
 * The last line when no server was found (`chat` and `setup` share it): nothing starts one for the
 * user, so the user does.
 */
export const START_SERVER_HINT =
  'Start one with `sheavly serve` in another terminal, then run this command again.';

export const CHAT_HELP = `Usage: sheavly chat [options] [first message]

Opens the terminal chat on your running server, which it finds through the discovery file and
checks with its handshake before it sends the token (or on the one BACKEND_URL names, with
BACKEND_TOKEN). It never starts a server: run \`sheavly serve\` in another terminal first.

Options:
  --trust              Trust the workspace's .sheavly/ folder (its hooks and settings)
  --setup              Open the setup: profiles, models and keys
  --profile <id>       Run on that profile
  --resume <id>        Reopen a stored conversation

The settings are environment variables: WORKSPACE_ROOT, SHOW_MODEL_CALLS and the rest of
apps/terminal/docs/chat.md.
`;
