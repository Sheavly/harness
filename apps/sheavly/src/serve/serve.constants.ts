export const SERVE_NAME = 'serve';

export const SERVE_SUMMARY = 'Run the server in the foreground';

export const SERVE_HELP = `Usage: sheavly serve [options]

Runs the harness server in the foreground, exactly as \`npm run serve -w @sheavly/backend\` does:
it takes the home's one-server lock, publishes its discovery file, prints its address (and a
token it made, when its output is a terminal and SERVER_TOKEN is not set), and stops on Ctrl+C or
SIGTERM.

Options:
  --trust   Trust the workspace's .sheavly/ folder (its hooks and settings)

The server refuses any other argument, and starts nothing.

The other settings are environment variables: SERVER_HOST, SERVER_PORT, SERVER_TOKEN,
WORKSPACE_ROOT, SHEAVLY_HOME and the rest of apps/backend/docs/serve.md.
`;
