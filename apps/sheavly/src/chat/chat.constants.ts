export const CHAT_NAME = 'chat';

export const CHAT_SUMMARY = 'Talk to the harness in the terminal';

export const CHAT_HELP = `Usage: sheavly chat [options] [first message]

Opens the terminal chat, as \`npm run dev:terminal\` does: it starts a backend of its own (or uses
the one BACKEND_URL and BACKEND_TOKEN name) and stops it on the way out.

Options:
  --trust              Trust the workspace's .sheavly/ folder (its hooks and settings)
  --setup              Open the setup: profiles, models and keys
  --profile <id>       Run on that profile
  --resume <id>        Reopen a stored conversation

The settings are environment variables: WORKSPACE_ROOT, SHOW_MODEL_CALLS and the rest of
apps/terminal/docs/chat.md.
`;
