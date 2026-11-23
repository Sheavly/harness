export const SETUP_NAME = 'setup';

export const SETUP_SUMMARY = 'Create or change your profiles, models and keys';

/** The last line of a setup that finished: what to run next. */
export const SETUP_DONE = 'Setup saved. Run `sheavly chat` to start a conversation.\n';

/**
 * The last line of a setup that ran on a server of its own, which is stopped now: a chat needs one
 * that stays.
 */
export const SETUP_DONE_PRIVATE =
  'Setup saved. To chat, start a server first (`sheavly serve` in another terminal, or `sheavly service install`), then run `sheavly chat`.\n';

/** What follows the lock-held message when setup could not start a server of its own. */
export const LOCK_HELD_HINT =
  'Setup starts none while another does: run `sheavly setup` again once it is up, or stop it first.';

/**
 * The failure of a server setup started but could not use: the lead, a reason when the lookup
 * failed for one it cannot say, what it found when that was not the server it started, and what to
 * add when stopping it failed too.
 */
export const STARTED_UNUSABLE = {
  lead: 'Setup started a server for itself but could not use it, so it sent nothing to it and stopped it:',
  unknown: 'the lookup failed for a reason it cannot say.',
  elsewhere: 'the lookup found another server than the one it started.',
  stopFailed: 'It could not stop that server cleanly:',
  stopUnknown: 'the reason is not known.',
};

/** Introduces what the server logged while it started, in a failure that follows. */
export const LOGGED_WHILE_STARTING = 'It logged while it started:';

export const SETUP_HELP = `Usage: sheavly setup

Opens the guided setup: choose or add a profile, add or change a model, and enter its key. The key
is typed without echo and goes to the server's credential store, nowhere else. Run it again to add
another profile or model, or to replace a key: the profiles and models that exist stay as they
are. It binds this folder (WORKSPACE_ROOT, else the current one) to the profile you pick.

It needs a terminal to ask in. It uses your running server, which it finds through the discovery
file and checks with its handshake before it sends the token. With no server running it starts
one for itself, on this machine only, for as long as the setup runs, and stops it when it ends
(or when you cancel): the same check applies to it before the key is sent. A chat needs a server
that stays, so start one afterwards (\`sheavly serve\`, or \`sheavly service install\`). A
server of another protocol is refused, and so is setup while another server is starting. It
ignores BACKEND_URL, since it sends a key (use \`chat --setup\` for a server BACKEND_URL names).
Esc or Ctrl+C cancels, and what was already saved stays.

Exit codes, for a program that runs it in a pane: 0 when the setup was saved, 130 when it was
cancelled, 1 when it could not run (no terminal, a refused server, another protocol), 2 for an
argument; a hangup, a terminate or an interrupt signal stops its server and ends it (129, 143 or
130, or by the signal itself). It prints one line on success and a failure's reason on stderr,
never a token or a key. A server it started leaves no lock or file behind, except when the
process is killed outright (SIGKILL) or crashes: a left-over file is then read as stale, and
the next server replaces it.
`;
