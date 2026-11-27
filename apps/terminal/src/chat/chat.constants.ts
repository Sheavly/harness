/** What `/help` prints. */
export const CHAT_HELP = `Type a message and press Enter to send it. The conversation keeps its history.
Keep typing while it works: what you send waits its turn.
When it asks to run a command, choose with the arrows or a number and press Enter; Esc skips it.
Ctrl+C stops the running prompt; pressed again with nothing running, it quits.
/model lists the models of your profile; /model <name> switches to one from the next prompt on.
/effort shows reasoning effort; /effort low|medium|high|extreme sets it and remembers it for this model.
File changes show as one collapsed line. /changes lists the files this chat changed; /changes <file>,
/changes #<n> or /changes all shows their diffs. A failed step with more to say than its first line
is collapsed too: /errors lists them and /errors #<n> shows one in full. Ctrl+O expands the latest
collapsed line, whether a change or a failure.
Tab after / lists the skills (and these commands); type more to narrow them.
/<skill> anywhere in a message runs that skill with the message, e.g. "/git submit" or "review this /review".
/exit or Ctrl+D (on an empty line) ends the conversation and stops what it started.`;

/** The width a diff is cut to where the terminal's isn't known (the plain line chat). */
export const LINE_COLUMNS = 80;

/** How many items of sub-agents' cards wait for the call that started them; the oldest give way. */
export const MAX_HELD_CARDS = 50;

/** How many tool calls the main agent has shown are remembered, so a card that comes late is drawn at once. */
export const MAX_SEEN_CALLS = 1000;

/** How many message ids the backend has finished with are remembered, for an answer that comes after its notice. */
export const MAX_RESOLVED_IDS = 64;

/** A line that is one of these ends the chat. */
export const EXIT_COMMANDS = ['/exit', '/quit'];

/** The chat's own commands, offered by Tab completion at the start of a line. */
export const CHAT_COMMANDS = [
  '/changes',
  '/effort',
  '/errors',
  '/exit',
  '/help',
  '/model',
  '/quit',
];
