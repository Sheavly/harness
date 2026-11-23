# The services a run shares

Why `createHarness` adds no tools or hooks, and how a UI composes a run on what it returns.

## Diagnostic message identity

New conversation prompts receive a stable user-message `id` before the session resumes. It is kept
in history and attached to stream activity as `messageId`, including failures and background sessions
started by that prompt. Providers do not send it to the model. Earlier messages without IDs remain
readable and are not renumbered on resume.

## Why it includes nothing

The packages provide the pieces and the services a run shares; a UI decides which provider a run
uses and which tools and hooks it includes, and composes them. No package picks a backend, a model,
a tool or a hook for it.

| Services                                    | For                                                                  | What it makes                                                                                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `createHarness` (`@sheavly/host`)           | Any LLM project: text parsing and extraction, chat wrappers, no repo | The session, task and approval registries a run shares, around the provider the UI picked. Opens no workspace and reads no file                |
| `createCodingExtension` (`@sheavly/coding`) | A coding agent in a repo                                             | An extension on a harness's run services: it opens its own `Workspace`, file reads and `ProcessRunner`, and takes the `KeyedLocks` it is given |

The UI builds its tools and hooks on those: `createTaskTools(tasks)`, `createSubAgentTool({ … })`
and `createMessageAgentTool` (`@sheavly/tools`); a coding UI's `createReadFileTool({ workspace })`,
`createRunCommandTool({ processes, … })` and the rest (`@sheavly/coding`); `agentsMdSource` (built with
`createInstructionHook` from `@sheavly/core`) and, if it trusts the workspace, `loadProjectHooks` (`@sheavly/workspace`). The backend does it in
one place, `createBackendHarness` (`apps/backend/src/harness/`), with its settings from env.

```ts
const harness = createHarness({ provider, title: prompt });

for await (const event of streamAgent({
  provider: harness.provider,
  instructions: harness.instructions,
  tools: [extractTool, ...createTaskTools(harness.tasks)],
  hooks: [],
  messages: [{ role: 'user', content: prompt }],
  tasks: harness.tasks,
  session: { registry: harness.sessions, ref: harness.mainSession },
}))
  render(event);
```

Pass `tasks` or `approvals` in when a tool needs the registry before the harness exists. Either
way, `createHarness` puts their updates in the sessions' combined stream (`kind: 'approval'` and
`kind: 'task'`), so a UI following the stream sees them without asking.

## Run services for extensions

A UI that composes its run from extensions (`@sheavly/extension`) hands the harness's state to all
of them the same way: `runServices({ harness, outputs, runSession })` (`run-services/`, in
`run-services.helper.ts`; `runSession` is the loop's runner) returns it as `hostService` entries
for `ExtensionHostOptions.services`. Every extension then reads it in `activate` without a
`dependsOn`, a built-in one no differently from a third-party one. The keys are defined in
`@sheavly/extension/run-services/run-services.utils`; the host implements them.

| Key (`run-services.utils`) | Value                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `INSTRUCTIONS`             | A read-only view of the system prompt: `text` composes at each read                |
| `MAIN_SESSION`             | `harness.mainSession`                                                              |
| `SESSION_INFO`             | Read-only session metadata, no message content                                     |
| `CHILD_SESSIONS`           | The sub-agents the extension started, and only those                               |
| `BACKGROUND_TASKS`         | The background tasks the extension started, and only those                         |
| `TASK_CONTROL`             | Reading and cancelling any task of a given session, whatever started it            |
| `OUTPUT_READER`            | Reading the complete command output; not provided when the app has no output store |
| `OUTPUT_CAPTURE`           | Starting an output capture; not provided when the app has no output store          |
| `MODEL`                    | The run's provider, for model calls                                                |
| `APPROVALS`                | Asking the user to approve something, and whether anyone is there to answer        |

Every service but the two constants is built per extension and checks a grant its `sheavly.json`
declares (what each allows and leaves out: [scoped run services](run-services.md)); no extension
is handed a session registry, a task registry, the whole output store or the loop. There is no
environment service: an extension's configuration comes through its settings (declared in its
manifest, `ExtensionHostOptions.settings`).

**Run services are not a sandbox.** An extension is code that can already do whatever Node can;
a grant limits what a service does for it, not what Node code can do. The app decides which
services it supplies (`runServices` returns a list it can filter) and which extensions it loads;
the host's only policy is the `origin: 'project'` trust gate (anything that is not `builtin` goes
through it), and no service reads `origin`. `origin` is declared by whatever loads the extension,
not by the extension: a loader for repo code (#332) must set `origin: 'project'` itself.

## Instruction composition

The system prompt is the generic core (`instructions/instructions.prompt.ts`), then the sections
the run's extensions contribute in activation order, then the app's own `instructions`
(`composeSystemPrompt`, `instructions/system-prompt.utils.ts`). Set `baseInstructions` to replace
just the generic core; omission uses the default (or the replacement an extension with
`system-prompt:replace` contributes) and an empty string omits it. An app's own `baseInstructions`
wins: a replacement an extension contributes next to it is refused with a
`BaseInstructionsConflictError` naming the extension, unless the app also lists the reserved name
`BASE_INSTRUCTIONS_SECTION` (`@sheavly/extension/instructions/instructions.constants`) in
`omitInstructionSections`. That option is the app's, never an extension's, and always wins: each
name in it is dropped from what the extensions contributed (a section by the name its manifest
declares in `instructions`; the reserved name drops a replacement base, which is then not applied
and conflicts with nothing, so the app's `baseInstructions` or the generic core is used). The names
are checked first, when `contribute` is called: one that matches no contributed section (or the
reserved name when no replacement was contributed) throws an `UnknownInstructionSectionError`
carrying `sectionName` and the sorted `available` names, takes nothing and does not use up the one
call. Duplicates are harmless and an empty list changes nothing. The option is checked where it
enters, before anything else: `undefined` means none, and anything but an array of non-blank
strings (a string, a number, `null`, an object, a blank entry) throws an
`InvalidOmitInstructionSectionsError` naming the option and the entry's index. The array is read
once and that copy is used. The option controls only the declared instruction sections. An
extension's tools, hooks, notices and any section whose name the app does not know are not
covered, and an extension can still infer an omitted section from the composed text: to remove an
extension's influence, leave the extension out. Because sub-agents read the
composed text, they get it without the omitted sections too. Blank sections are skipped, outer whitespace
is trimmed, and sections are joined with one blank line (`joinInstructions`, from
`@sheavly/extension/instructions/instructions.utils`, which extensions use for the same join). A
replacement base is review-only: the review record `npm run lint:prompt` checks covers the host's
own base, not an extension's text.

`createHarness` builds a `SystemPrompt` (`harness.systemPrompt`) that composes this text each time
it is read, because the harness exists before any extension activates. The app gives it what the
extension host merged, once, after every extension has activated
(`systemPrompt.contribute({ sections, replacement })`, the backend does it from the activation
result's `instructions`, `baseInstructions` and `baseInstructionsBy`): it is for the app, not for
extensions, copies and freezes each section, and a second call throws a
`SystemPromptAlreadyContributedError`. So during any extension's `activate` the text is only the
base plus the app's own instructions, and a read made later (such as `agents`' read when it
starts a sub-agent) sees the contributions. `harness.instructions` on
the object `createHarness` returns, and the `INSTRUCTIONS` run service (`{ text }`, read-only,
frozen), always read the current text; a copy of the harness (`{ ...harness }`) holds the text of
the moment it was made. With no extension contributing instructions the text is exactly what
`composeInstructions` returns for the same options, so a host that does not use the contract is
unchanged. A coding app adds `createCodingExtension`, whose `coding` section lands between the
core and the app's extras, even when the core is replaced; generic hosts receive no coding
section and require no workspace.
`createConversation` uses the harness text unless its own `instructions` is explicitly supplied.
That existing option is a complete override, not an extension; an empty override remains empty.
Direct `streamAgent` or `runAgent` callers pass the returned string explicitly.

The generic core tells the agent to finish independent work, then yield without tool calls while
waiting for required background results. Status inspection is limited to requested updates or
diagnosis, not waiting. This rule belongs in stable system instructions as well as task-tool
guidance; models must not turn immediate snapshots into a wait loop. It names no particular tool
and applies equally to commands and sub-agent work.

The core also prefers dedicated tools for file work and requires reading relevant files before
editing. Delegation guidance covers which work to split, not how to call a particular tool.
Tool descriptions continue to own their parameters, limits and execution mechanics.

Git/GitHub policy is conditional on the task: commits require an explicit request, preceded by
status, diff and history inspection, intended-file staging and result verification. Configuration
changes and hook bypasses are forbidden; destructive operations and history rewrites require
explicit authorization. PR preparation inspects the full branch against its intended base,
including remote tracking. Use `gh` when available, but editing or committing never implies
permission to publish or change issues. The text contains no repository-specific branch, label,
commit-message or merge conventions. The hook-bypass prohibition governs agent requests; it does
not guarantee repository hooks run. The coding command runner independently disables repository
hooks through its existing safety environment, which prompt wording does not change.

The backend passes its composed shared text to the child factory; the child adds its role,
then any child-specific extras. Other hosts explicitly choose what children receive. Parent
conversation overrides and history are not implicitly inherited. All models use the same text,
including unknown families and pinned children; switching providers does not rebuild it.

The default's adjacent `@system-prompt-review` comment is development metadata, not model-facing
text. `harness/system-prompt-review` checks the reviewed production prompt/tool sources and the
base prompt's own hash plus an explicit decision and reason; `npm run lint:prompt` runs it across
workspace boundaries. This is
an offline review gate, not proof of semantic freshness or model compliance. Its watched-source
scope and limitations are documented in [the rule](../../eslint-config/docs/rules.md#system-prompt-review).
Custom bases and conversation overrides remain host choices; the record does not restrict them.

Before-turn instruction additions follow static text through the loop. AGENTS.md and skills
remain deduplicated append-only conversation context, preserving signed-thinking prefixes.
Replacing prose never changes tools, permission checks or project hooks.

## A conversation across prompts

A UI the user keeps talking to wraps its harness in `createConversation({ harness, run: streamAgent,
tools, hooks })` (`@sheavly/host/conversation/`). Every `send(prompt, { signal })` runs the next
prompt on the history so far, in the harness's main session, and yields its events:

- Between prompts the session is `idle` (a `session_idle` update, with how the prompt ended as
  `lastOutcome`), and the next prompt resumes it (`session_resumed`); it never ends on its own.
- A normal prompt sent while one runs is refused with a `SessionError` (`session_running`).
  Text is never delivered to a running prompt. `conversation.yieldPrompt()` (and
  `conversations.yieldPrompt(id)`) instead asks it to end as `completed` at its next completion
  point, without waiting for finite tasks or sub-agents, which keep running; their results are
  delivered to the next prompt. It returns `false` for an idle or stopping prompt, and closed
  conversations throw `session_ended`. What the user types while a run goes waits in the
  conversation's queue, outside history: `Conversations.submit` queues it and the conversation
  starts it once that run has ended (see the README). `conversation.state` is the one answer to
  what runs now: `idle`, `prompt` or `wake`, moved only along `CONVERSATION_RUN_TRANSITIONS`
  (a move outside the table throws `ConversationRunError`).
- The history is written when a prompt starts (previous finished history plus this prompt) and
  when it ends or fails, as for any prompt. In-flight model/tool work remains in the separately
  persisted stream; it joins the history snapshot when the run ends or fails.
- Aborting `signal` stops that prompt with valid history, and the next continues from it. A failed
  run keeps the user's prompt, added context, completed assistant turns and tool results. Tool
  effects are not undone by a provider failure, so history must not roll back either.
- Finite background tasks, including sub-agents, keep the prompt alive and resume the model
  automatically with their completions. Persistent services do not keep it active and may outlive
  a prompt; their completions are reported at the next model call.
  Aborting a prompt cancels its background work, including services, sub-agents and their
  descendants. Individual cancellations remain visible in the combined task/session stream,
  but do not create completion notices for the next prompt or resume unfinished work.
- `close()` ends the live conversation: it stops the running prompt, cancels background tasks (and
  their processes) and ends the session. It deletes nothing: `messages` stays readable, and
  `createConversation({ …, messages })` continues it in a new one.

Keeping a conversation across process restarts (saving `messages`) is the UI's to do.

## Generic, and coding on top

Generic code never needs a project on disk or a coding tool.
The loop, the generic runtime services (`sessions`, `tasks`, `approvals`), the generic tools
(`sub-agent`, `tasks`) and `createHarness` import none of the workspace-bound services
(`workspace`, `process`, `trust`, `project-hooks`, `agents-md`) or the coding tools
(`read-file`, `write-file`, `edit-file`, `files`, `run-command`), and neither do their tests. Only
a coding UI reaches them, which is why each lives in a package of its own and the generic ones
never depend on the coding ones.
