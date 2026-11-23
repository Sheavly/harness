export const SERVICE_NAME = 'service';

export const SERVICE_SUMMARY = 'Run the server as a systemd user service (Linux)';

/** The subcommands, in the order the help lists them. */
export const SERVICE_ACTIONS = [
  'install',
  'uninstall',
  'start',
  'stop',
  'restart',
  'status',
  'logs',
] as const;

/** The systemd unit's name, and the file that holds the token, beside the user's data. */
export const UNIT_NAME = 'sheavly.service';
export const TOKEN_FILE_NAME = 'service.env';

/** The variable the server reads its token from: the token file holds one line of it. */
export const TOKEN_VARIABLE = 'SERVER_TOKEN';

/** How many bytes of randomness make the token, as the terminal makes the one it hands a backend. */
export const TOKEN_BYTES = 32;

/** A token the server accepts: at least 32 characters of the alphabet `base64url` makes. */
export const TOKEN_LINE = /^SERVER_TOKEN=([A-Za-z0-9_-]{32,})$/;

/** The characters a path may have to be written into a unit without quoting rules in doubt. */
export const PLAIN_PATH = /^[A-Za-z0-9._/@+-]+$/;

/** How many journal lines `logs` shows, unless it follows. */
export const LOG_LINES = 100;

/** What `systemctl is-active` prints for a unit that is not running (a failed one included). */
export const STOPPED_STATES: readonly string[] = ['inactive', 'failed'];

export const SERVICE_HELP = `Usage: sheavly service <action>

Runs the server as a systemd user service, so it is always on without a terminal holding it open
and starts again after a failure, a logout or a reboot. Linux with systemd only.

Actions:
  install     Write the unit and the token file, turn on linger and start it (asks first; --yes skips)
  uninstall   Stop it and remove the unit and the token file; your data and linger stay
  start       Start the service
  stop        Stop it (conversations that are running stop with it)
  restart     Restart it, which stops the conversations that are running
  status      Say whether it is installed, enabled and running, and whether linger is on
  logs        Show the last 100 lines of its journal (--follow keeps going)

The unit runs the built command (\`node dist/cli.js serve\`), so build first (\`npm run build\`);
it uses the PATH and SHEAVLY_HOME of the shell that installs it, and installing again refreshes
them. The token is made once and kept in a file only you can read, which the unit passes to the
server; it is never written into the unit. \`install\` refuses --trust: a server-wide --trust would
trust every folder with hooks or settings that any conversation opens.
`;
