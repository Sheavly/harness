# Node kinds an extension contributes

**Specification, not built.** The wire model ([wire-model.md](../../protocol/docs/wire-model.md))
has nodes of three built-in kinds, `agent`, `command` and `service`, and lets an extension add
kinds of its own. This page says how, so that the work in
[#433](https://github.com/Sheavly/harness/issues/433) starts from a written design; it leaves
that issue the questions it names. It follows the
constraints of decision 5 of [#438](https://github.com/Sheavly/harness/issues/438), and it is built
on what an extension already has: declared work kinds, the `emits` mechanism for events, the
scoped `background-tasks` service with its grants, and the trust gate on project code.

## What a kind is

A node kind is a **kind of work an extension starts**, seen on the wire. Today an extension
declares a kind of background work in its manifest's `workKinds` and starts it through the
`background-tasks` service with `startWork`. In the wire model that work is a node (the registry
of #423), and its kind is the work kind's name: `<extension>.<name>`, like `notes.sync`. A kind of
work and the node it appears as are the same thing, so the kind is not named twice. What is new is
described below, and it is more than one key: a kind is declared in the manifest's `workKinds`,
contributed with its wire shape in `activate`, and its channel entry types are listed in `emits`.
A work kind's `completion` (`finite` or `service`) decides the node's built-in behaviour: a
`finite` kind can be awaited and ends in a terminal state, a `service` kind is never awaited and
may outlive a run, as a `command` and a `service` node do today.

This keeps every node owned by a process the extension started, which is what lets the host cancel
it, mark it `lost` after a restart and hold it to the extension's grants. A node that is not work
(a pure view, say) is out of scope.

## Declaring and registering a kind

- **The manifest** already lists the kind in `workKinds`, and the host's existing check holds: a
  kind the manifest does not declare fails the activation, and a wildcard entry (`"notes.*"`)
  declares kinds not known in advance. **New enforcement:** today a work kind's namespace is only
  a convention (the manifest's namespace check is applied to `settings`, `emits.events` and
  `serves.actions`, not to `workKinds`), so the host must also refuse a
  work kind, and a wildcard's prefix, outside the extension's own `<extension>.` namespace. Without
  it a kind could be named in another extension's namespace or as a built-in.
- **`activate` contributes its wire shape**, beside `events` and `notices`:
  `nodeKinds: [{ kind, version, schema }]`. `schema` is the extension's zod schema for the node's
  `data`, `version` is a positive integer, the version of that shape, as for `events`. The host
  checks that each `kind` is declared in `workKinds`, is in the extension's own namespace and is
  contributed once, and records the names and versions then, as it does for events, so a
  contribution that changes after the check fails the extension
  (`ExtensionContributionChangedError`).
- **Entry types on the node's channel** are declared the same way events are: listed in the
  manifest's `emits` (`emits.entries`, names in the extension's namespace) and contributed with
  `entries: [{ type, version, schema }]`. An entry type is namespaced like the kind.
- **No registry is held.** The extension never touches the node registry (#102;
  `harness/extension-no-runtime-registries`). It starts a node through the scoped service and sets
  what the node shows through the same scope; the host owns the node.

## What a kind sets, and what the host owns

Every node has the common fields: id, parent, kind, title, state, times, and the link to the
tool call that spawned it. The host owns the id, parent, state, times and link. The extension
sets, through its node scope, the **title**, a **status text**, a plain-text **`text`** fallback
and a kind-specific **`data`**.

- **`data`** is JSON the extension's own schema checked, at most `MAX_EXTENSION_DATA_BYTES`
  (16384) bytes serialized, as for `extension_event`. **`text`** is 1 to `MAX_EXTENSION_TEXT_CHARS`
  (2000) characters of plain text. Both are checked at each set, and a failure is an
  `ExtensionEmitError` naming the issue paths and never the values.
- **The title and the status text are bounded too.** Each is single-line plain text with a
  character cap set in the protocol's constants (the same order as `text`). What is refused when
  it is set is the class the terminal already escapes (`plainTerminalText`: control and format
  characters and the line and paragraph separators), and newline and tab with them, since a
  title with a newline would draw as several lines and could pass for a prompt of its own. That
  refuses a zero-width joiner too, and so some emoji sequences. A front end still shows both
  escaped, never as markup, and shows the kind beside an extension's title, since a title can
  imitate a built-in's. What is stored before this check, or arrives without it, is guarded by the
  front end's own escaping, which is the guard that counts.
- **A node's `title`, status text, `text` and `data` are for front ends, and `data` never reaches
  the model.** Today the model does see text an extension's work sets: a work kind's `command` and
  `description` are in the running-tasks and task-finished notices, where the title and command
  are only escaped and kept to one line (`escapeTags`) and the output and a report are fenced as
  data. The task tools (`task_status`, `await_tasks`) return a task as a plain, unfenced tool
  result, and a sub-agent's last status and report reach its parent the same way. When the loop
  and the tools read a node instead of a task (#424), a node's title and status text written by
  an extension are untrusted data in each of those places, and **must be escaped at least as
  they are today, and fenced where a body is**, never inserted as prompt text. That is a
  requirement on #424, which this page cannot enforce.
- **The states are the host's and are the same for every kind**: `running`, `completed`,
  `failed`, `cancelled`, `lost` (`idle` is for agents). An extension cannot add a state, because
  every front end has to understand state. It can add status text.
- **Entries on the node's channel** go through `emit.entry({ node, type, data, text })`, a
  capability of the same kind as `emit.event`: held to the manifest's `emits`, checked against the
  contribution's schema and the same caps, and disarmed when the extension stops. **`node` must be
  a node the calling extension started**: an entry for any other node, another extension's or a
  built-in's, is refused, so an extension cannot write into a node it does not own. `opened` and
  `closed` are written only by the host, and `emit.entry` cannot produce them, so an extension
  cannot forge a state or an end. An entry after the node's `closed` is refused, so a channel
  ends where it says it does. The caps above are per entry, so a node also has a quota on the
  number of its entries and their total bytes, and an entry past it is refused with a typed
  error: without one a node could grow the conversation's log without bound. An entry's
  cursor is one of the two built-in kinds: a gapless sequence, or, for a kind that streams bytes,
  a byte offset. The kind chooses at registration, and cannot invent a third.

## Grants

**No new grant.** Starting a node of the extension's own kind is `task:start`; reading its own is
`task:read`; cancelling its own is `task:cancel`. They keep their meaning when the scoped
service is made over the node registry (#423, #424). Reading or cancelling another extension's
nodes is `task:read-any` and `task:cancel-any`, as today. `emit.entry` needs no grant, as
`emit.event` needs none: it is gated by the manifest's `emits`. A new grant is added only when a
kind does something these do not, and as a new capability, never a widened one.

`task:read` reads the node's own state and channel entries, which are its own work. It does not
become a way to read a command's complete output: that stays `output:read`, and the channel that
serves a command's output (#428) must not let `task:read` read another extension's command output
that `output:read` would refuse. The `-any` verbs keep today's trust: they take a session id the
caller names and the service cannot check it.

## Trust

A node kind from repository code stays behind workspace trust. A `project` extension is skipped
(`untrusted`) unless the host says its code is trusted, so its kinds are not registered and it can
start no node. A node already stored for such a kind, in a conversation opened without that
trust, is not an error: it renders as a node of a kind the front end does not know (below), and the
stored entries are read with the protocol's envelope schema only.

## Rendering a kind it does not know

A front end never trusts a kind and never refuses on it, as with `extension_event.kind`:

- A node of an unknown kind is shown from its **common fields** (title, state, times, parent)
  plus its **status text** and **`text`**, escaped as plain text. A sidebar, a tree and a
  notification need nothing more.
- An unknown entry type on its channel is shown by its `text`, or skipped.
- `data` is for a front end that knows the kind. The protocol does not look inside it: the host
  checks it against the extension's schema when it is set, and a reader checks only the envelope
  (the name patterns, the version and the caps).

## What stays outside this

- **Ordering and cursors** are the model's, not the kind's: per-channel cursors and the causal link
  from the child's `opened` to the parent's cursor ([wire-model.md](../../protocol/docs/wire-model.md#ordering)).
- **A node that outlives its extension.** The host disarms the extension's scopes when it stops,
  which refuses new calls and does not cancel what is running (see "Disarming" in the extensions
  guide). The node stays `running` until something cancels it, and becomes `lost` when the
  conversation is reopened after a restart. Whether disarming should also cancel is a question for
  #433, not decided here.
- **This is least privilege, not a sandbox,** like every grant: an extension is Node code, and
  what the host checks is only what goes through the services and `emit`.
