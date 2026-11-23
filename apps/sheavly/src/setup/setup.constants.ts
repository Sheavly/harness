export const SETUP_NAME = 'setup';

export const SETUP_SUMMARY = 'Create or change your profiles, models and keys';

/** The last line of a setup that finished: what to run next. */
export const SETUP_DONE = 'Setup saved. Run `sheavly chat` to start a conversation.\n';

export const SETUP_HELP = `Usage: sheavly setup

Opens the guided setup on your running server, which it finds through the discovery file and
checks with its handshake before it sends the token: choose or add a profile, add or change a
model, and enter its key. The key is typed without echo and goes to the server's credential
store, nowhere else. Run it again to add another profile or model, or to replace a key: the
profiles and models that exist stay as they are. It binds this folder (WORKSPACE_ROOT, else the
current one) to the profile you pick.

It needs a terminal to ask in, and a server: it never starts one, and it ignores BACKEND_URL,
since it sends a key (use \`chat --setup\` for a server BACKEND_URL names). Run \`sheavly serve\`
in another terminal first. Esc or Ctrl+C cancels, and what was already saved stays.
`;
