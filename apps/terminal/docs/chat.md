# The chat

## Chat diagnostics

Kept chats have a private `errors.jsonl` beside `history.jsonl` and `stream.jsonl` under
`~/.sheavly/profiles/<profile-id>/workspaces/<workspace-key>/conversations/<chat-id>/`.
The startup line prints the chat ID. Find its log with:

```sh
find ~/.sheavly -path '*/conversations/<chat-id>/errors.jsonl'
```

Records include timestamps, chat/session IDs, stream sequence and originating user-message IDs.
Look up `messageId` as a user message's `id` in history, or find the event by `seq` in the stream.
The modern UI reports run errors with that message ID too. Run diagnostics include selected error
details, a bounded stack and cause chain. Tool and hook failures name their tool call or hook.
Prompts, tool inputs and successful outputs are not copied. Common credential forms are redacted,
but error text and paths can still be private: review logs before sharing.

## Model-first setup

Run `sheavly setup` (or `npm run dev:terminal -- --setup`, which also opens a chat afterwards),
choose a profile, then **Add a model**:

1. **What model do you want to add?** Select a backend-provided model, or **Custom model** and
   enter its name/identifier.
2. **How do you want to host it?** Select a compatible, registered hosting route. GPT models offer
   Azure, OpenAI and AWS Bedrock; Claude offers Azure and AWS Bedrock; DeepSeek Flash currently
   offers Azure (Bedrock does not serve it). Other native providers are not advertised as working
   routes without their adapters.
3. **Context size**: "300K" (the default) or "1M", how much context the agent is told it has. It
   paces itself by it, so a smaller size tends to cost less; it limits nothing the provider accepts.
4. Enter that route's connection details and masked key. Azure deployment names may differ from
   the chosen model. Native model IDs are filled in without asking the same question again.
   AWS Bedrock asks for a Region, the **inference profile** (a prefix, then the model, such as
   `us.anthropic.claude-sonnet-5-5`; you choose the prefix, and `global` lets requests run in any
   Region), for Claude the output limit per reply, and **Credentials**: `api-key` (a Bedrock API
   key) or `access-key` (an IAM access key ID and secret access key, and a session token if they
   are temporary). Setup then asks only for the secrets of the way you chose; they are stored apart
   from the model's settings. Editing the model to sign in the other way asks for the new way's
   secrets again, which replace the old way's. The profile must be the chosen model's own. See [models on Bedrock](../../../packages/providers/docs/backends.md#models-on-amazon-bedrock).
5. Save and finish (a chat then opens, unless this was `sheavly setup`), or explicitly test the
   connection (a small paid API call).

The selected identity is stored as model metadata, separate from hosting settings and credentials.
It records the user's selection, not a verified cloud deployment inventory. DeepSeek's Azure
preset uses Chat Completions and enables plain-reasoning replay, not encrypted Responses items.
Its portal Chat endpoint is accepted directly. Thinking mode is a separate advanced option,
left at the deployment default unless explicitly selected. Advanced settings
remain editable. Existing model definitions without identity continue to work unchanged.

## Running a conversation

One conversation you keep talking to, in the terminal: `npm run dev:terminal` from the repo root
(from source), `npm run dev -w @sheavly/terminal`, or `npm run start -w @sheavly/terminal` (built
first, then plain Node), or `npm run dev` / `npm run start` inside `apps/terminal`.
`npm run dev:terminal -- "first message"` starts with that message. It works from the folder you
start it in (the default workspace), and calls the real API, so it costs money. The root has
`dev:terminal` but no plain `dev` or `start`: each UI has its own.

- Each message continues the same conversation, on the [backend](demo.md#the-backend) the chat
  starts: the model sees the history so far, in one session, idle between messages. The chat is
  a UI like any other: it reaches the conversation only over HTTP, as an editor would.
- **On a terminal it is a screen**, drawn on the terminal's main screen: what has happened scrolls
  up into the terminal's own history, so its scrollback, search and text selection keep working,
  and only the bottom is redrawn (the line being written, a question waiting for you, queued
  messages, a status line and the editor). The status line says what it is doing (`ready`,
  `working`, `waiting for you`), the model, the branch of the working root once the agents chose
  one (`⎇ <branch>`, refreshed after each turn), the folder's permission mode (`allow all` in red)
  and what runs in the background (`2 tasks and 1 service running in background`: finite work
  and services counted apart, each only when some run). Without a terminal (piped input, or
  `SHEAVLY_PLAIN=1`) it reads and writes lines, as it always did.
- **React and Ink draw the screen.** Completed lines are committed once with Ink's static output;
  the bounded live footer shows activity, elapsed time and `Ctrl+C to stop` while working.
  While a tool runs it also names the step and how long that step has run
  (`⠹ working · 41s · Ctrl+C to stop · ⏺ Run the tests 12s`), counting up with the spinner; with
  several tools at once it says how many and times the oldest. It follows the loop's
  `tool_call_started` and `tool_result` events and is cut from the end first, so the stop hint
  stays. A printed `⏺` line is in the scrollback and is never rewritten: only the footer is live.
  While the main session's provider signals reasoning (`reasoning_activity`), the Ink footer and
  the classic status line say `thinking...` instead of `working`, without printing any reasoning.
  A provider with no signal keeps `working`, a sub-agent's reasoning is ignored, and `waiting for
you` keeps its own words.
  The classic screen shows no step, and neither does the plain line chat. The editor and approval state machine are shared with the previous renderer, selected with
  `SHEAVLY_TUI=classic`. `NO_COLOR` removes styling from React's conversation and editor. No alternate
  screen or mouse capture is used. Static history is not replayed on resize: the terminal owns
  its reflow, while the footer is laid out again at the new size.
  The root development command explicitly loads the terminal's JSX config; its backend subprocess
  resolves its own workspace config rather than inheriting the terminal's `tsx` config path.
  The hardware caret is committed with the current editor frame, including wide characters and
  wrapped input, so typing does not leave the cursor on the previous character.
  Screen rendering follows the output's TTY status even when `CI` is set; piped output remains
  non-interactive and does not receive screen redraw or caret controls.
- **Reduced motion is a global user preference.** Run `npm run dev:terminal -- --setup`, choose
  **Terminal settings** in the profile menu, then **Reduced motion**. No profile needs to exist
  to configure it. The React working
  indicator uses a static `●`; prompt and tool times still update once per second, and state
  changes and `Ctrl+C to stop` remain visible. **Animated** restores the spinner (the default).
  The setting is `terminal.reducedMotion` in `~/.sheavly/config.json`, saved through the backend
  API, not an environment variable. It applies to all profiles when a chat opens, including
  `--resume`; the terminal reads it from `GET /setup`.
  Classic and plain chat are already static; streamed replies still arrive normally.
  The real terminal adapter suppresses erase-scrollback controls from the classic renderer,
  including sequences split across writes. A viewport redraw never clears earlier scrollback.
- **The terminal bell is opt-in and global.** In `--setup`, choose **Terminal settings**, then
  turn **Terminal bell** on. `terminal.bell` in `~/.sheavly/config.json` defaults to false and
  applies when the chat opens. It sends BEL directly to the terminal once for a backend-confirmed
  completed reply, a new approval request, or each tool reaching five seconds. Repeated status
  updates do not ring again; a finished tool cancels its timer. Errors, interrupted replies and
  chat commands do not produce a completion bell. Stopping a prompt cancels pending tool alerts,
  and closing the chat silences it. React and classic screens both support it, independently of
  reduced motion and `NO_COLOR`; plain mode, piped output, the demo and workbook stay silent.
  Whether BEL makes a sound, flashes or is ignored depends on your terminal's own bell settings.
- **Context usage and estimated cost stay in the status line.** React and classic screens show
  `context 142.5k / 300K (48%)`: the main session's latest reported input plus output, against
  its configured context window. This is a last-call measurement, not a live count of streamed
  output or newly added tool results. Cache tokens are already included in input; output includes
  reported reasoning. Sub-agent calls never add to the main context count. Resuming restores the
  last measurement, and switching models updates the window. Missing usage clears the count to
  `?` instead of keeping a stale value. Cost remains cumulative across all sessions, including
  costs recorded with the rates used then. Unknown or incomplete cost is omitted. Known costs have
  a `~` estimate marker and are in USD. The backend accepts optional model `pricing` with `input`,
  `output`, `cacheRead` and `cacheWrite` rates per million tokens, through the model API or its JSON
  file. Rates are not fetched automatically and the setup form preserves, but does not edit them.
  The setup form does ask for a model's context size, "300K" or "1M", when a model is added or
  edited, starting on its current size or 300K. A model whose size is another (given by its file
  or host) shows it by its exact count as an extra first choice, and keeps it unless changed. It is what
  the agent is told it has, for cost, not a limit on the provider (see the backend's model API).
  At narrow widths the trailing statistics may be clipped; activity and the stop hint come first.
- **A failed model run is not a completed reply.** A failed run ends with the main session's
  `done` carrying reason `failed`, after `run_failed`, and the chat reports the message as failed.
  A stopped message is reported `interrupted`, and a run still going when the conversation's
  stream is lost for good is `failed`. Partial text stays visible and the chat remains
  available; the original exception is in the backend log.
- **A complete approval preview must fit.** If the React footer cannot show the command,
  concerns and permission hints together, confirmation is disabled. Enlarge the terminal to
  review it or press `Esc` to skip; a clipped preview never grants permission.
  Commands, concerns and grant hints render controls and direction overrides as visible escapes,
  not executable terminal sequences. Literal backslashes are escaped too, so `\n` text is distinct
  from an actual newline. The original backend request is never modified.
  Streamed replies, tool-start text, errors and sub-agent labels are also escaped before trusted
  styling is applied, so a control sequence cannot execute before its approval appears. File-link
  labels and diff/error text receive the same protection. Backend history and tool arguments stay
  unchanged; reply newlines, tabs and Markdown still render normally.
- **The reply is drawn as Markdown, a block at a time.** Emphasis, inline code, headings, links,
  lists, quotes, tables and fenced code are drawn as styled terminal text, wrapped to the
  screen's width. A block (a paragraph, a list, a table) is drawn once it is complete, at a
  blank line, because a later line can change how the ones above it look. Until then its raw text
  shows in the live area. A fenced code block is the exception: its lines are drawn as they
  arrive, so a long one doesn't wait for its closing fence, and only the line being written shows
  raw. Code tagged `ts`, `js`, `json`, `sh`, `python`, `go` or `rust` (and their usual
  aliases) is coloured: keywords (bold, in the accent colour), strings and numbers (their own
  roles), and comments (secondary, italic).
  The colouring reads tokens, not grammar, so it can be wrong on unusual syntax; other languages
  stay plain. No part of the code is told apart by colour alone. With `NO_COLOR` (React screen)
  no styling is added, and inline code and strike-through are written out between backticks and
  `~~`. A table wider than the terminal wraps inside its cells, breaking a word that is longer
  than its column; when the columns can't fit at all, it shows as its wrapped source. The demo,
  the workbook and line mode keep the reply as written.
- **The conversation reads as a conversation.** Each message you send is shown after a `›`, then
  the reply, with a blank line between it and the steps around it. A step is one
  dim line (`⏺ Run the tests  $ npm test`) and its result under it (`⎿ ✓ … · 0.3s`, in red when
  it failed); the loop's bookkeeping (event counts, stop reasons, sub-agent ids) is left out.
  Output-limit recovery continues seamlessly, without an activity line, warning or reply break.
  The backend still emits structured recovery notices for other UIs to render as they choose.
  Exhausting an explicitly configured recovery limit warns that the reply is incomplete; a context-limit warning instead asks
  you to reduce the conversation or start a new one. Turn limits and stopped runs are also said. The
  demo and the workbook keep the complete plain log, which their saved runs and checks read.
- **Colours are roles, and a theme says which colour each one is.** Nothing in the chat asks for
  "red" or "cyan": it asks for `text.secondary` (what can be skipped: ids, hints, borders),
  `text.accent` (what marks a place: a step, a link, the chosen option), `status.success`,
  `status.error`, `status.warning`, `diff.added`, `diff.removed`, `code.string` or `code.number`.
  A theme is data, one terminal colour per role, in `theme/theme.constants.ts`; the colours are
  the terminal's own named ones (never hex), so the user's terminal theme still decides how they
  look. `SHEAVLY_THEME` picks one when the screen starts:
  - `default`: the colours the chat always had (green, red, yellow, cyan, gray).
  - `colorblind`: for red-green colour blindness. Success and added are bright blue, error and
    removed are yellow, warning is magenta, and strings and numbers in code are bright blue and
    magenta, so no pair that has to be told apart is red against green.

  A name that is no theme stops the chat with the ones there are, instead of picking one for you.
  Colour is never the only sign: a result carries `✓` or `✗`, a diff line `+` or `-`, a limit `⚠`,
  and every theme says the same words. `NO_COLOR` still removes all styling, whatever the theme.
  The theme reaches the working indicator, the status line, the steps, `/changes`, `/errors`,
  Markdown and the editor's menus; the demo and the workbook log have no colour to choose.
  Not yet: whether gray reads on a light background, and a theme set from a profile rather than
  the environment.

- **A file change shows as one collapsed line, and expands when you ask.** Under the result of
  `write_file`, `edit_file` and `delete_file` the chat prints `▸ +2 −1 · /changes 3`: the lines
  added and removed, and the number of the change. A created file says `· new file` after the
  counts and a deleted one `· deleted`. Finished lines live in the terminal's scrollback, which a
  program can't rewrite, so a diff is never expanded in place: asking prints it again, in full,
  below. Every change the chat made is kept, numbered from 1 in the order made, and shown with:
  - `/changes` lists the files changed, each once, with what all its changes came to and which
    changes they were (`src/a.ts  +12 −3  #1 #3`, `new` for a created file and `deleted` for one
    removed).
  - `/changes #3` (or `3`) shows that one change; `/changes src/a.ts` (or the end of the path)
    shows the file's total, from before its first change to after its last; `/changes all` shows
    every file's total.
  - Ctrl+O shows the newest collapsed line in full, whatever else is on screen: the latest
    change's diff, or the latest failure's message if that came after it.

  A diff has two lines of context, a line number, and `+`/`-` in green and red; the stretch
  between two changes folds into `⋯ N unchanged lines`, a new file is all `+` and a deleted one
  all `-`. It ends with `… N more changed lines` after 500 rows. A line wider than the screen is
  cut with `…`, so it never wraps away from its number, and terminal escapes in the file's text
  are dropped. A rewrite too large to compare shows only how many lines it covers. Only the
  changes the terminal has seen are kept: a conversation reopened with `--resume` starts with the
  ones made after it opened. The plain log leaves file changes out; the plain line chat has
  `/changes` too, as text.

- **A failed step shows its first line, and the rest when you ask.** A tool that failed prints
  `✗` and the first line of its message, cut at 100 characters. When the message says more (more
  lines, or a first line that was cut), a collapsed `▸ 12 more lines · /errors 2` goes under it.
  As with changes, it is shown again below, never expanded in place. `/errors` lists the failures
  kept, numbered from 1, each with its step and first line; `/errors #2` (or `2`) shows that one's
  whole message without escape codes. A message over 100 lines shows its first 30 and last 70,
  where a command says what it ran and what went wrong, and counts the lines between. A failure
  that is one short line has nothing more to show and keeps no number. The plain log and the plain
  line chat print failures as before; the line chat has `/errors` too, as text.

- **Links open, and a terminal can jump between your messages.** Two terminal features, both
  invisible where unsupported:
  - _Hyperlinks_ (OSC 8). A Markdown link in a reply is a link on its text, without the address
    printed after it, where the terminal opens them; elsewhere it reads `text (address)`. The
    file paths of `/changes` (the list and each diff's header) link to the file, a `file://` link
    under the workspace. Over SSH they stay text, since the link would name a path on the
    machine the terminal is on. Support is detected from the terminal (iTerm2, kitty, WezTerm,
    Ghostty, Windows Terminal, VS Code, Alacritty, Warp and others; tmux only if it forwards
    them; GNU screen never). `SHEAVLY_HYPERLINKS=1` or `0` overrides the detection. With
    `NO_COLOR` the React screen shows addresses, never hyperlinks, because it strips every
    escape sequence. A path in a tool step's line is not a link yet.
  - _Turn markers_ (OSC 133). The message you send is marked as a prompt (`A`, `B`), the row
    under it as where output starts (`C`), and the first row after the turn closes it with its
    status (`D;0`, or `D;1` when it failed; a stop is not a failure). Terminals that read them
    (iTerm2, kitty, WezTerm, Ghostty and others) can jump to the previous or next message and
    select a turn's output. Ink drops every escape sequence but styling and hyperlinks, so the
    React screen writes each marker as a private styling code and the stream to the terminal
    (`restoringMarks`) turns it into the real sequence. The last turn stays open until
    something is printed after it. There is no setting to turn them off; a terminal that doesn't
    know them ignores them. A line that is a command (`/help`, `/changes`) is not a turn.

- **A command you haven't allowed asks you.** It shows the command and why it asks, and the offered
  choices: run it once, allow it for this session when offered, always allow it (kept for this folder, [see permissions](../../backend/docs/api.md)),
  skip it (the model is told not to retry), or skip and type what to do instead (the model reads
  it as your direction). `↑↓` or the displayed option numbers choose, `Enter` confirms, `Esc` skips. Nothing is chosen
  when the question appears, so an `Enter` meant for something else never runs a command; and as
  soon as you type into the editor, every key is the editor's and the question waits. Several
  questions wait in order, `+N more waiting` says how many. With a plain line chat there is no one
  to ask, so such a command is refused and the model told why.
- **Always allow shows the command being approved.** Its hint lists base-command grants, such
  as `touch *`, `git diff *`, `npm run test *` or `npx eslint *`, including every entry for a chain.
  All options, paths and other arguments of that command are allowed. If a backend omits the
  entries, the choice keeps its generic hint. See the
  [entry rules](../../../extensions/coding/docs/run-command.md#who-decides).
- **Command-prefix grants can last for this session or this workspace.** When offered, the
  session choice shows the same proposed prefixes as Always allow but explicitly says they are
  not saved. npm scripts keep `npm run <script> *`; npx keeps `npx <command> *`, without pinning
  package versions or distinguishing check/fix modes. `find *`, `sed *` and `node *` include
  editing and execution options. No separate path, secret-file or package-verification approval
  follows a command grant. Built-in approvals have the same behavior; `always_ask` always asks.
- **Grants are command-only.** The UI shows the base-command scope a grant gives. Different
  programs, Git/GitHub CLI subcommands and npm scripts still need their own approval.
- **You can type while it works; messages wait their turn in the backend's queue.** A message is
  sent at once, and the backend decides: it starts it, or, while a run goes (a prompt, or a run
  it started itself to deliver finished background work), keeps it in the conversation's
  first-in, first-out queue, outside the history and summaries. The chat keeps no queue of its
  own: it shows the backend's, from the conversation's stream, as `⏳ N queued`. The backend starts
  a queued line itself once the model has finished its turn, without waiting for background tasks
  or sub-agents (those keep running and their results are kept for the next prompt). While the
  agent waits on `await_tasks`, the line stays queued while the grouped tasks run (the status line
  says "follow-ups are queued" when a line waits), then runs once the model has finished. A line
  is shown as sent (`›`) when the backend starts it. One the backend refuses (a queue that is
  full, a line too long to queue, or a queued line that cannot start, such as an unknown skill) is
  printed as `✗` with why, and the chat goes on. Chat commands (`/model`, `/changes`, `/exit`,
  etc.) run at once, even while a run goes. The editor takes several lines (`Shift+Enter`), keeps
  your history (`↑` at the top), completes `/` commands and skills with `Tab`, and folds a large
  paste into one marker. Steering a running agent is not supported.
- Finite background commands and sub-agents keep the prompt active until their results arrive.
  Persistent services can outlive it; their completions are reported at the next prompt.
- A message has no turn limit: the model keeps working until it is done, so Ctrl+C is how you stop
  one that goes on (`MAX_TURNS` in the backend's environment sets a cap if you want one).
- Ctrl+C stops the running message (and skips a question it waits on); history stays valid, and the
  next message continues from it. With nothing running, Ctrl+C asks to be pressed again to quit,
  so one stray press never ends the conversation. Pressed again while the message is still
  stopping, it force-quits in the screen chat and the plain line chat alike: the conversation and
  its backend are ended first (a backend that ignores SIGTERM is killed after ten seconds), then
  the process exits 130. At the line chat's input line it quits. Ctrl+C during startup stops the
  backend that is starting. Lines waiting are still sent after a stopped message; leaving drops them.
- `/model` lists the models of your profile, with their ids, and `/model <id or name>` switches to
  one, from the next model call on, keeping the history
  ([models and keys](../../backend/docs/harness.md#models-and-keys)). The switch is made by
  id; a name only finds the model, and one that two models share is refused.
- `/<skill>` anywhere in a message runs that [skill](../../../extensions/coding/docs/skills.md)
  with the message, at the start (`/git submit`), in the middle or at the end
  (`review this, then /git`), including `disable-model-invocation` skills. A message that starts
  with a `/name` no skill has is reported as an unknown command and not sent. Skills that didn't
  load are listed, with why, when the chat starts. Tab after a `/` completes skill names (and,
  at the start of the line, the chat's commands); press it twice to list them.
- `/exit`, `/quit` or Ctrl+D (on an empty line) ends the conversation: it stops what it started
  (background commands, sub-agents) and ends the session. `/help` lists this.
- Plain and piped input keeps reading lines while a prompt runs, sending them in order like the
  interactive editor. End of input waits until every line the backend accepted has run.
- Closing the terminal window or `kill` (SIGHUP, SIGTERM) closes the conversation and the
  backend too, so its background commands don't outlive the chat. A `kill -9` can't be caught,
  but the backend still stops: its stdin, a pipe from the chat, closes.

The settings are the demo's ([the demo](demo.md#settings)). Conversations are kept by the backend
across restarts. `npm run dev:terminal -- --resume <conversation-id>` reopens one under its own id,
with its saved history, workspace and model selection. An optional message after the id is sent
as the next prompt. A failed prompt keeps completed tool work and the user's message.

A conversation resumed with `--resume` runs on the profile it started on. A `--profile` given
with it that names another profile is ignored, and the terminal says so before it reopens
anything: `→ conversation <id> runs on its own profile Home (<id>); --profile <id> ignored`.

### A chat on a chosen profile

`npm run dev:terminal -- --profile <profile-id>` starts the chat on that profile (the demo takes
the same flag). The id is the profile's lowercase UUID, as in `~/.sheavly/profiles/<id>/`; it is
removed from the prompt words. An explicit profile beats the workspace binding, which beats the
default profile.

It is for this run only: nothing is bound, no default changes and neither `config.json` nor
`profile.json` is written, so chats on different profiles can start at the same moment. Setup is
not consulted for it (`queryWorkspaceProfile` and the readiness check of the workspace are
skipped); the named profile is checked instead, before a conversation opens:

- a malformed id fails like a malformed `--resume` id, and a missing value is the same error;
- an unknown id is `There is no profile <id>`, never a fall-back to another profile;
- a profile that exists but has no usable model or key is reported by name as not ready;
- `--setup` with `--profile` is refused: setup binds a profile and sets the default.

The startup banner says which profile the chat runs on, next to the conversation line:
`→ profile Work (<id>)`. `/model` and `/effort` still remember their choice on that profile.

## Setup

### Model effort

`/effort` shows the current reasoning effort. `/effort low`, `/effort medium`, `/effort high` and
`/effort extreme` change it, with the selection shown in the status line. The profile remembers
the effort for this model, separately from every other model. `/model` switches restore the
selected model's latest remembered effort, or medium when it has none. Existing conversations
and sub-agents retain their own selections; new conversations use the profile's latest pair.
Efforts take effect at the next model call, not midway through a response.

On a workspace without a ready profile, the interactive chat opens setup before creating a
conversation. You can also open it explicitly with `sheavly setup`, which runs it on the running
server and ends without a chat, or with `npm run dev:terminal -- --setup`, including when a
profile already works.

1. Choose an existing profile or create one, such as Personal or Work.
2. Choose an existing model or add one. For a new model, choose a provider from the backend's
   installed adapters. The form asks the context size ("300K" or "1M"), then only for required
   fields, using provider defaults for optional ones. It derives a display name from the model/deployment; use Edit model settings
   to rename it or change advanced values. Claude's output limit defaults to the model's documented 128000 for recognized IDs. Reasoning
   effort defaults to medium until you select an effort.
3. Enter the settings and API key. The key is masked, including paste, and sent only to the
   write-only credential route. Existing keys are never loaded into an input or shown again.
   For Azure Claude models requiring adaptive thinking, choose **adaptive** under Thinking mode
   and leave Thinking budget empty. Max tokens is the output limit per reply, not the context
   window; leave it empty for the model's default, and set one only to lower it. A low value
   can cut off adaptive thinking before any text or tool call.
4. Choose **Save and finish**, or **Test connection** to make a small provider API call.
   A failed check lets you replace the key or edit the model settings in the same screen.

The chosen profile is bound to this workspace; an existing default for other workspaces is kept.
The first profile also becomes the default. The selected model is used for the new conversation.
Reopen `--setup` to add more profiles or models, edit model settings, or replace a key. All writes
go through the [setup API](../../backend/docs/api.md#setting-the-backend-up), including when the
terminal connects to an existing backend.

Esc or Ctrl+C cancels setup and stops a backend this terminal started. Settings already saved
remain available to finish next time. An unconfigured chat with piped input exits with a short
instruction to run interactive setup first; it never consumes the piped text as a key. A ready
workspace goes directly to chat, with no setup questions.
