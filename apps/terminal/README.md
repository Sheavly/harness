# @sheavly/terminal

The terminal front end, with three entry points on [the backend](../backend/README.md): each
starts a backend of its own (or connects to one running, `BACKEND_URL`), talks to it over HTTP
like any other UI, and stops it on the way out. It never reads the server's discovery file
(lint enforces it in `client/`), so a development terminal does not attach to a stable server
unless `BACKEND_URL` is set; with `BACKEND_URL`, its `--trust` is sent to that backend for the
terminal's own folder before the conversation starts, and the conversation runs in that same
folder (for a new conversation; `--resume` runs in the saved folder). The request gives up after
10 s, and a refusal prints as one line of at most 200 characters, hidden entirely when it echoes
any 8 characters of the token; [the backend it uses](docs/demo.md#the-backend)).

```bash
npm run dev -w @sheavly/terminal                                   # a conversation you keep talking to
npm run dev:terminal -- --setup                                    # add or update profiles, models and keys
npm run dev:terminal -- --resume <conversation-id>                  # reopen a saved conversation
npm run dev:terminal -- --profile <profile-id>                     # start on a profile, for this run only
npm run demo -- "Read package.json and tell me the project name"   # one prompt, printed as it happens
npm run workbook -- list                                           # stored prompts and saved runs
npm run replay -- last --summary                                   # a stored run or conversation, no model call
```

The chat guides an unconfigured workspace through setup before opening its first conversation:
choose a profile, the model to add, then a supported hosting provider. Enter connection settings
and a masked key, then start chatting. No
config files need editing. `--setup` opens the same UI again for another model or profile, or to
replace a key. Setup uses the backend API; a connection check is an explicit choice.

The backend supplies the model catalogue: Sol, Astra, Luna, Opus, Sonnet and DeepSeek Flash,
with only implemented compatible hosting routes. **Custom model** accepts another model identity
and any registered adapter. Azure asks for a deployment name separately; native model IDs are
already chosen. See [model setup](docs/chat.md#model-first-setup).

To extend the picker, update the [backend's model catalogue](../backend/src/profiles/model-catalog.constants.ts)
and its compatible hosting policy, not a second list in this UI. The setup API supplies the choices.

Workbook checks can require the adapter recorded in run metadata with `expect.adapter`.
The `deepseek-chat` check requires `azure-chat`; it cannot pass on a different transport just
because the model claims that identity. See [real-model checks](docs/workbook.md#real-model-checks).
For executable check markers, `expect.toolResults` inspects recorded successful tool output,
even when the renderer shows only its size. A final-reply claim cannot satisfy that assertion.
`forbid.toolErrors` can also reject recorded denied attempts, so a working guard does not hide
an unsafe model decision behind an otherwise passing check.

Prompts call the real model API and cost money (a fraction of a cent for a short prompt).
They run on the models and keys in your profile (`~/.sheavly`, see
[models and keys](../backend/docs/harness.md#models-and-keys)); the other settings come from the
environment and go to the backend it starts ([the backend's settings](../backend/docs/serve.md#settings)).
`WEB_FETCH=false` disables public web reading for the main agent and sub-agents. It is enabled
by default and validated by the backend; when connecting to an existing backend, use its setting.

| Folder          | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client/`       | Reaching a backend (`connectBackend`, `withBackend`, `stopProcessGroup`), one conversation on it (`RemoteConversation`: its background counts and approvals come from the conversation's tree, its usage (the total and the main agent's context) from the backend's usage channel (`watchUsage`), and `watchTranscript` merges the tree and the main agent's channel into typed chat items (`ChatItem`); `openConversation`, `closeSession`), `trustFolderOnAttached` (`--trust` to a running backend), `saveRawStream` |
| `interrupt/`    | Ctrl+C for the demo, workbook and line chat: `interruptOnCtrlC`, `abortingStop`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `demo/`         | The demo's run (`runDemo`) and its default prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `render/`       | The `Renderer` every entry point prints a conversation's stream with, in a look: the chat's or the log's                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `tui/`          | The chat's input and approval controller, shared editor, and classic screen fallback                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `react-screen/` | React/Ink rendering: append-only native scrollback and a bounded live footer                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `markdown/`     | A streamed reply drawn as Markdown: a block at a time, a code fence line by line (`MarkdownStream`)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `diff/`         | A file change as rows (`buildDiff`, `countChanges`) and as styled lines (`formatDiff`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `changes/`      | Every file change a chat made (`ChangeLog`), shown collapsed, listed or in full (`/changes`, Ctrl+O)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `failures/`     | Failed steps with more to say than their first line (`FailureLog`): collapsed, `/errors`, Ctrl+O                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `marks/`        | OSC 133 turn markers: what stands for one through Ink, and the stdout that restores them                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `links/`        | OSC 8 hyperlinks: the `SHEAVLY_HYPERLINKS` setting and file links                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `theme/`        | The colour of each role (`status.error`, `diff.added`...) per theme, and the `Palette` that paints them                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `bell/`         | Opt-in terminal alerts for reply completion, approvals and long-running tools (`TerminalBell`)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `usage/`        | The status line's usage text (`usageText`): the main agent's context against its window and the estimated USD cost, from what the backend counts                                                                                                                                                                                                                                                                                                                                                                         |
| `setup/`        | Guided profile, provider, model and credential setup through the backend's API                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `replay/`       | A stored conversation or workbook run, replayed through the `Renderer` or summarized (`npm run replay`), with no backend or model                                                                                                                                                                                                                                                                                                                                                                                        |
| `workbook/`     | The workbook CLI: stored prompts, saved runs, continue, step, diff and checks                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chat/`         | The chat's logic (`ChatSession`: what the stream shows, stop, commands), its line mode, and Tab completion                                                                                                                                                                                                                                                                                                                                                                                                               |
| `chat.ts`       | The chat CLI: one conversation across prompts                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `demo.ts`       | The demo CLI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `replay.ts`     | The replay CLI: a stored conversation or run, rendered or summarized                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The `sheavly` command (`apps/sheavly`, the launcher) runs the chat in its own process, so the
terminal exports exactly three entry files: `@sheavly/terminal/chat/start.helper`
(`runTerminalChat({ env, args, server })`, the process's own by default, which works in the
current folder; `server` is a backend the command found and verified, connected to as
`BACKEND_URL` is and never started or stopped) and `@sheavly/terminal/chat/chat-failure.helper`
(`reportChatFailure(error)`, the message and exit code a chat that could not run ends with; a URL in the message loses its user name and
password, so a `BACKEND_URL` that holds them is not echoed) and
`@sheavly/terminal/setup/run-setup.helper` (`runTerminalSetup({ env, server })`, the setup wizard
on a running backend and no conversation, which `sheavly setup` runs; `server` is required, a
backend the command found and verified: it never starts or stops one and does not read
`BACKEND_URL`, since setup sends a provider key). `chat.ts` is only the call, with the
folder change npm needs. Nothing else is public: the layout check refuses an export
`LAUNCHER_ENTRIES` doesn't list (`packages/eslint-config/docs/layout.md`).

The terminal makes no choice about a run: which model, tools and hooks it gets is the backend's
([what a run includes](../backend/docs/harness.md)). The terminal decides how to show it.

The backend owns whether a conversation is busy and its queue. A message is sent at once: the
backend starts it, or keeps it in the conversation's FIFO queue, outside its history and
summaries, while a run goes (a prompt, or a run it started itself to deliver finished work). It
starts the line itself once that run's model has finished (after an `await_tasks` wait too), as
an ordinary prompt. The chat shows what the conversation's stream says: the queue, the echo of
a line when it starts, its output and its end. Chat commands run at once. Plain input reads
continuously too.

Interactive chat uses React and Ink. `SHEAVLY_TUI=classic` selects the previous renderer;
`SHEAVLY_PLAIN=1` keeps linear input and output. Both interactive renderers share the editor,
completion, paste folding, queue and approval decisions. `SHEAVLY_THEME=colorblind` swaps the
colours that tell success from failure for ones that stay apart in red-green colour blindness
([colours](docs/chat.md)); `NO_COLOR` removes styling from the React screen.
`SHEAVLY_HYPERLINKS=1|0` forces OSC 8 links on or off; otherwise they follow the terminal
([links and turn markers](docs/chat.md)).
Reduced motion is global: in `--setup`, choose **Terminal settings** in the profile menu.
It replaces the spinner with a static marker while elapsed times update once per second.
The preference is stored in `~/.sheavly/config.json`, shared by every profile.
The same menu has **Terminal bell**, off by default. When enabled, it rings for completed replies,
new approvals and tools that reach five seconds. Both interactive renderers support it; plain
and piped output stay silent.
The interactive status line shows the main agent's latest input plus output against its configured
context window, not cumulative billed tokens, as the backend's usage channel says it. Estimated
cost still includes sub-agents and resumed history. Window labels match model setup (`300K` and `1M`). Missing context usage shows `?`;
unknown cost is omitted entirely. A failed main run is
reported visibly, even when the stream ends without a final reply.

Structured `harness_notice` events are intentionally omitted from the conversation transcript.
Output-continuation notices leave streamed replies open, with no continuation line or cutoff marker.
The status line reads the backend's usage; another UI can present notices differently without
changing the backend or interpreting model-facing text. A persistent notice (a finished task, or a
sub-agent's report) is ignored too: the task line and the sub-agent's own updates already show the
finish, so the terminal does not add duplicate cards for individual or grouped completion notices.
Typed completion context remains available in history and events for UIs that want to present it:
the reason, start time (epoch milliseconds), duration, number of user messages since the task started,
and optional originating call ID. Grouped notices retain their wait reason and each member's optional
context; task snapshots can also carry a reason.
The current terminal deliberately omits this timing, reason and conversation context from its output
and does not let these notices change progress indicators. An extension's own `extension-notice`
is a persistent notice too, so the transcript omits it as well.

An `extension_event` is drawn as one line, `<extension>: <text>`: the extension's plain-text
fallback, squeezed onto one line and escaped as plain terminal text, so control characters and
escape sequences from third-party code are shown as visible `\u…` codes and never reach the
terminal. The renderer never switches on the event's `kind`, so a kind it has never heard of shows
its fallback like any other, and `data` is never printed. The workbook's `step` describes it by
kind and the first line of its text.

## Docs

Model failures show the reported cause and originating message ID instead of a generic error.
Kept conversations have a private `log.jsonl` for correlating failures with stored messages;
see [chat diagnostics](docs/chat.md#chat-diagnostics). Restart a backend after updating its source.

- [The chat](docs/chat.md): one conversation across prompts, and how to stop or end it.
- [The demo](docs/demo.md): its settings, and how the terminal reaches its backend.
- [The workbook](docs/workbook.md): stored prompts, saved runs, checks, and the `workbook/` folder.
