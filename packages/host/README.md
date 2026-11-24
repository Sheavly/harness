# @sheavly/host

The services one run shares: `createHarness` makes the session, task and approval registries and
starts the main session, around the provider a UI picked (with `onModelCall` seeing every model
call). It adds no tools or hooks and reads no settings: a UI decides what a run includes and
composes it on these services. No UI, no project on disk.

```ts
import { createHarness } from '@sheavly/host/host/host.helper';

const harness = createHarness({ provider, title: prompt });
// harness: { provider, instructions, sessions, mainSession, tasks, approvals }
```

| Module           | What it holds                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `host/`          | `createHarness`, and its `HarnessOptions` and `Harness` types                                                   |
| `instructions/`  | `SystemPrompt`, `composeSystemPrompt`: base, extensions' sections, then extras                                  |
| `run-services/`  | `runServices`: the services behind the keys `@sheavly/extension` defines                                        |
| `conversation/`  | `createConversation`: one conversation across prompts, in one session                                           |
| `conversations/` | `Conversations`: the live conversations a host serves, by id, and kept ones                                     |
| `errors/`        | `ConversationsError`; scope errors `ScopeArgumentError`, `ApprovalToolNotContributedError`, `ChildRunningError` |

A UI the user keeps talking to wraps the harness in a conversation: each prompt continues from
the history so far, in the same session, idle between prompts until `close`. A failed prompt
keeps the user's message and completed tool work, rather than rolling back history while leaving
the tool effects on disk. A prompt ends when the model finishes, even while background tasks or
sub-agents run; only `await_tasks` keeps it open. When finite work finishes while the conversation
is idle, it starts a run itself (no new user message) so the model sees the notice; that run's
events reach every UI through the combined stream, and `conversation.stop()` stops it. `send`
through `Conversations` first asks such a run to end (`settleWake`), so a user's line is the next
prompt. Services never wake it: their notice reaches the next prompt. It wakes as often as work
finishes: an app that wants a limit sets `maxConsecutiveWakes`, and `onWakeCapped` tells it when
that limit keeps a notice waiting for the user's next prompt. A `summary` option (`SummaryOptions`,
`@sheavly/core`) is handed to every prompt's run, so the loop summarizes the history when the
context nears the window; the host never picks a summarizer, the app does.

```ts
import { createConversation } from '@sheavly/host/conversation/conversation.helper';

const conversation = createConversation({ harness, run: streamAgent, tools, hooks });

for await (const event of conversation.send(prompt, { signal })) render(event);
await conversation.close();
```

A prompt cannot be given more text while it runs. `conversation.yieldPrompt()` asks the running
run to end as `completed` at its completion point instead of waiting on ungrouped work (finished
results reach the next prompt). A run held on `await_tasks` ignores the yield until its grouped
tasks have settled and the model has finished. It returns `false` for an idle or stopping run
(`true` even when a hold ignores it), and closed conversations throw `session_ended`.
`conversation.state` says what runs (`idle`, `prompt` or `wake`, moved only along
`CONVERSATION_RUN_TRANSITIONS`), and `whenIdle()` waits for it to end.

A UI sends what the user types with `Conversations.submit`, which answers at once: the prompt
starts when nothing runs, or waits in the conversation's queue (`PromptQueue`), which yields what
runs and starts the next line once it has ended. While a line waits, or a prompt prepares its
skills, finished work starts no run of its own (`deferWakes`): that prompt delivers it. A line
leaves the queue only once it has started. The conversation reads the runs it starts, so their
entries reach every UI on the combined stream, with a `queue` entry for each change to the lines.
Lines kept with a stored conversation are parked when it is reopened, until the user sends the
next one; so is a queued line a stop reached while it prepared its skills.

A host serving several conversations (the HTTP server, or a UI in-process) keeps them in a
`Conversations`, built on a function the app gives that composes each one (provider, tools,
hooks, skills, and the `run` it reports: workspace, models and trust, for `details` and
`useModel`). The server only turns requests into these calls, so in-process and remote UIs
behave the same:

```ts
import { Conversations } from '@sheavly/host/conversations/conversations.service';

const conversations = new Conversations({ create: (options) => buildConversation(options) });
const id = await conversations.start();
// Starts at once, or waits behind what runs; the runs' entries come on the combined stream.
await conversations.submit({ id, prompt: { text: 'hi' } });
// An in-process UI that reads one prompt's events itself, when nothing else runs:
const { events } = await conversations.send({ id, prompt: { text: 'and then?' } });
```

A coding UI adds `createCodingExtension` (`@sheavly/coding`) to the run built on this.

The harness composes domain-neutral instructions, then the sections the run's extensions
contribute, then the app's own. `instructions` in `HarnessOptions` adds the app's extras;
`baseInstructions` replaces only the generic core (an empty string omits it) and wins over an
extension's replacement, which is refused. `omitInstructionSections` is the app's way to use an
extension without its prompt text: it lists section names (the ones extensions declare in their
manifests' `instructions`) and the reserved `BASE_INSTRUCTIONS_SECTION` from `@sheavly/extension`
for a replacement base. A name nothing contributed throws an `UnknownInstructionSectionError`
listing the available ones, so a typo is never silent; a value that is not an array of non-blank
strings throws an `InvalidOmitInstructionSectionsError`. The option controls only the declared
instruction sections. An extension's tools, hooks, notices and any section whose name the app does
not know are not covered, and an extension can still infer an omitted section from the composed
text: to remove an extension's influence, leave the extension out. The text is composed at each read (`harness.systemPrompt`
takes what the extensions contributed once, after every one has activated; `INSTRUCTIONS` reads it
live, so it holds them only for a read made after that), so with no contributing extension it is
exactly the generic core and the app's extras.
The default stays compact: task scope, approval/data boundaries, yielding for required background
results instead of polling, concise communication, dedicated-tool preference, read-before-edit and
self-contained delegation. Conditional git/GitHub guidance requires explicit commit authorization,
inspection before commits and PRs, and separate publication permission; it forbids configuration
changes and bypassing hooks. It contains no repository-specific conventions, tool mechanics or
model-specific overlays.
Conversations read `harness.instructions` at each prompt by default. An explicit conversation `instructions`
string remains a complete override, including an empty string. Direct loop callers pass
`instructions: harness.instructions` themselves. See [instruction composition](docs/harness.md#instruction-composition).

`await conversations.useModel({ id, modelId, effort? })` changes one conversation's selection.
The app restores that model's remembered effort when omitted. Switches for one conversation are
serialized; a failed switch rejects its caller but does not block a later one. The main session
and stored index retain the selected effort. Reopening passes the saved model/effort pair to the app,
not the profile's more recent preference.

**Keeping conversations.** Give `Conversations` a `store` (`ConversationStore`,
`@sheavly/core/store/`) and every conversation is kept as it runs: its stream goes to the store
through the `storage` the host hands `create` (`entries` for `createHarness`, `keepHistory` for
`createConversation`), its history is written when a prompt starts and when it ends, and an index
entry says its title, model and whether it is open or closed. `listStored()` lists past
conversations (`listStored({ search })` those whose title has it, ignoring case), and `reopen(id)` brings one back under its own id, continuing from its history: its
stream is numbered on from the last stored entry, a tool call that never returned gets a
placeholder result, and a sub-agent that was running is `interrupted`. A sub-agent whose report
never reached the history gets an `agent-report` notice appended (its report read back from its
stored history, empty for one that did not complete), which the model sees at the next prompt;
reopening starts no run. If storage fails, the
conversation takes no more prompts (`storage_failed`) instead of carrying on unrecorded. With no
store, nothing is kept and everything behaves as before.

Each node's channel is kept too, beside the stream, through `storage.channels` (`createHarness`'s
`channels`): the agents', commands' and services' own logs, written as the conversation runs. A
write that fails is announced once as `storage_failed` and ends no run, since the stream is still
the record; that channel takes no more entries. `reopen` closes every node channel the stopped
process left without a `closed` entry as `lost`, before the conversation has a node of its own, and
only once: reopening again finds them closed. That repair is best effort: a channel the store
cannot read or close (a damaged file, a failed disk) is left as it was, and the conversation still
reopens. They are announced together as one `storage_failed` on the reopened conversation's stream,
naming how many and the first reason, so thousands of damaged files do not flood it; a channel that
stays damaged is announced again on each reopen. A `reopen`
of a conversation that is still being closed waits for the close to finish its writes.
`Harness.nodeChannels` is the writer, which `close` waits for.

## Docs

Normal prompts sent with `send` have stable UUID `id`s, persisted in history and attached to stream
entries as `messageId`. The ID is assigned before the resume update, so even early failures can be
linked to the right prompt. Providers never send these IDs to the model.

- [The services a run shares](docs/harness.md): what `createHarness` makes, and how a UI composes
  a run on it.
- [Scoped run services](docs/run-services.md): the per-extension services extensions read
  (`session-info`, `child-sessions`, `background-tasks`, `task-control`, `output-reader`,
  `output-capture`, `model`), the grant each method checks and what each leaves out.
