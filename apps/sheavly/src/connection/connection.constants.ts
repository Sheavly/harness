export const CONNECTION_NAME = 'connection';

export const CONNECTION_SUMMARY =
  'Print the verified server connection as JSON (it holds the token)';

/** The one argument the command takes: it names what is printed, a secret, so it is required. */
export const JSON_FLAG = '--json';

/** What it says when stdout is a terminal: why, and how to read the line anyway. */
export const TERMINAL_REFUSAL =
  'sheavly connection prints the server\'s token, and this output is a terminal, where it would stay in the scrollback: send it to the program that reads it, for example "sheavly connection --json | jq .url".';

export const CONNECTION_HELP = `Usage: sheavly connection --json

Prints how to reach your running server, for another front end such as a tmux client, as one
line of JSON on stdout:

  {"source":"discovery","url":"…","token":"…","protocolVersion":"…","serverVersion":"…"}

The server is found through its discovery file and proven by its handshake before the token is
printed, as \`sheavly chat\` does. With no verified server it prints nothing, says why on stderr
and exits 1 (a server of another protocol says which side is older). It never starts a server,
never contacts one whose lock is free, and sends the token nowhere.

With BACKEND_URL and BACKEND_TOKEN set it prints those instead, and contacts nothing:

  {"source":"environment","url":"…","token":"…"}

That connection is not verified: the handshake needs the server's instance id, which only its
discovery file holds, so "source" says which one you got. BACKEND_URL without BACKEND_TOKEN is an
error, and so is one that is not a plain http or https URL with no login in it;
BACKEND_TOKEN alone is ignored, as it is by \`sheavly chat\`.

THE OUTPUT IS A SECRET. It holds the token that runs commands as you: do not log it, put it on a
command line, or share it. --json is required so that running this says so, and it refuses to
write to a terminal, where the token would stay in the scrollback: pipe it to the program that
reads it (\`sheavly connection --json | jq .url\`).
`;
