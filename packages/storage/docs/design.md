# Design

How this workspace works inside, why it is built this way, and how to extend it.

## The conversation log

A conversation's `log.jsonl` is the one place its failures are written: a private file of
`LogEntry` lines (`@sheavly/logger`), beside `stream.jsonl` and `history.jsonl`. Two things write
it, and both make their entries with `createLogEntry`, so there is one shape and one redaction:

- **The stream's failures** (`run.failed`, `hook.failed`, `tool.failed`, `ConversationLog` and
  `failureEntry`) are a projection of the authoritative stream. Each has the stream entry's `time`
  and `seq`, its `conversationId`, `sessionId` and `messageId`, plus the model, tool-call or hook
  identity and a failed run's captured `details`. Join `messageId` to a user message's `id` in
  history and `seq` to the exact stream event. Background sessions retain their originating
  message even when the parent starts another prompt. Old streams without message ids are replayed
  without invented ones.
- **What the backend logs about the conversation** reaches the file through `logSink(id)`: an
  error that ended a request or a background run, with its stack and cause chain.

The stream is authoritative. The first append after reopening trims partial lines and replays
missing failures into the log, using the highest `seq` of a line that is one of the stream's own
failure events (`isStreamFailureEvent`) to avoid duplicates; whatever else the backend logged is
not part of the replay, whatever fields it has. A failed projection write becomes a storage
failure, so the host refuses further prompts instead of silently continuing unrecorded.

The backend's lines are not awaited by its logger, so they go through one `OrderedAppends` per
file (`jsonl-file/`): each waits for the one before it, and the file holds them in the order they
were logged, even from two sinks made for one conversation. A sink's write is the caller's
logger's to isolate: its failure never reaches the request. Deleting a conversation marks it
deleted, waits for the lines already asked for, then removes the folder; a line that arrives
after the mark is dropped, so a failure while a conversation closes cannot bring its folder back.

Failures with no conversation go to `<home>/logs/backend.jsonl` (`serverLogSink`). Neither file is
trimmed or rotated; a person deletes them.

Files use private permissions. Only selected exception fields are serialized, never
request/response objects, authentication headers or tool inputs. Credential forms and
identity-shaped text in error text are redacted, but paths and error messages can still be
private: review logs before sharing.

## History logs

`FileConversationStore.history({ id, session? })` is a session's durable history: an append-only
`history.jsonl` (the main session's) or `agents/<session-id>.history.jsonl` (a sub-agent's), one
record a line, `{ seq, entry }`. `seq` starts at 0, has no gaps and names an entry for good, so a
checkpoint can say what it covers and a lost write shows as a gap. Entries are never rewritten or
removed, so original messages stay retrievable after a summary.

`HistoryFile` and `EntryFile` are both an `AppendLog` (`conversation-store/append-log.service.ts`):
the next `seq` is counted from the file once, after a line cut off by a crash is trimmed, and
appends go one at a time through a queue. An append at any other `seq` is refused
(`out_of_order`) and a file with a gap is refused when read, rather than hidden. A new
append-only file is an `AppendLog` with its schema, not a copy of this logic.

A whole-file `history.json` or `agents/<session-id>.history.json` beside the logs is not read,
written or removed.

## Channel logs

`FileConversationStore.channel({ id, channel })` is the durable log of one channel of a
conversation (the wire model's channels, #438): the entries of a node, or of one of the
conversation's own channels, `tree` and `usage`. It is `channels/<channel>.jsonl`, an entry a line,
in the order they were written, each with
the channel's own cursor: the entry's number in a channel that numbers its entries (`s0`, `s1`, …),
or an offset in bytes in a command's or a service's (`b0`, `b40`). An agent's holds its lifecycle
and each loop event of its session (an entry of up to 64 KiB, or a marker for one that would not
fit), so its file grows with the conversation and is bounded by the channel quota like any other. A channel is named for a node id
(lowercase, so two names cannot differ by case on a disk that ignores it) or is one of the
conversation's own (`tree`, `usage`), and no other name becomes a file (`namedPath` with the
channel name schema).

What may be appended, and what is kept, is one function, `channelAppendEntry` (`@sheavly/core`),
which the memory store applies too, so the two cannot disagree. An entry has to be one the store
can read back (`storedChannelEntry`: JSON, at most `MAX_CHANNEL_ENTRY_CHARS` of it, 64 KiB, far
under the longest line a file is read back with, and the shape a stored line is read as), or it is
`invalid` and not written. What is kept is that JSON parsed again, a plain copy, and everything
after is done to that copy: its order below is checked on it and it is what is written, so a
`toJSON` or a getter on the caller's object cannot pass at one cursor and be stored at another, and
a line holds its keys in the schema's order, not the caller's. Then it has to be the next one
(`channelAppendProblem`): the first entry is `opened` at
cursor 0; a sequence goes on by one and a byte offset never goes back, in one kind of cursor;
nothing opens twice, nothing follows `closed`, and an entry of another channel is not this one's;
or it is `out_of_order` and not written. Which kind of cursor a node's channel uses is the
writer's: the store keeps one kind, it does not look at the node. The file is read once in a
process (after a line cut off by a crash is trimmed) for how many lines it holds, the last of them
and where blocks of lines start, which are then kept and kept current by every append, and appends
go one at a time through a queue; a channel's file is not locked, since a conversation belongs to the one process
serving it, as the stream does. That read holds every line it reads to the same rule, so a file
edited by hand into a log with a gap, a repeat or another channel's line is refused when it is next
appended to or read, naming the file, as the stream's and the histories' gaps are. With an index
(below) it reads only the lines after what the index covers. Entries are never rewritten or
removed, and go with the conversation. A write that arrives after `delete` recreates the folder,
as the other files' do (#241). A write that failed may have reached the file: the channel reads it
again before the next, so a sequence cursor is refused a second time, and a byte cursor, which may
repeat, can be stored twice if the writer sends it again.

`FileConversationStore.channels(id)` lists the channels a conversation has stored: the regular
files `channels/<channel>.jsonl` whose name is a node id or one of the conversation's own (`tree`, `usage`). A marker, an index, a link, a
folder, a stray file or a name that is not a channel's is not listed, and a conversation with no folder has
none. A reopened conversation reads it to find the channels whose node never closed.

A read starts at `start`, at the last `n` entries (`{ tail }`) or after a cursor the reader kept
(`{ after }`). A cursor the channel does not hold or that is not a cursor, or a tail that is not a
whole number from 0 to `MAX_TAIL` (1,000), is `cursor_out_of_range`. `start` streams the file
and never holds it whole. A tail and an `after` read the entries they give and no more than a
block of lines besides, however long the channel is (see "What a channel holds"). Several entries of a byte channel can
share an offset, and an `after` that offset starts after the first of them. A byte channel's bytes
are not here: the output store serves them, by offset, and its log holds only the entries it was
given (the `opened` and `closed` around them).
A line that is not an entry of a channel, or is damaged, fails the read naming the file and the
line, never showing what was on it. The stored line is the protocol's own entry, derived once as
`storedChannelEntrySchema` (`channel-entry.validator.ts`); the storage package's lint
(`storedFileReads`, from `@sheavly/eslint-config`, with its tests) refuses source that imports the
protocol's whole-log schemas (`channelLogSchema`, `channelBoundarySchema`) anywhere else, so a log is
read a line at a time through one definition and never as the array those schemas check. Reading
what an entry's type holds is for the code that knows the type, after the store has handed it over.

**What a channel holds, and where to read from.** `head()` says how many entries a channel holds and
the newest (its channel, cursor and type), without reading it: a channel nothing was written to has
none of either, and asking does not make it. The file store counts a channel's file once in a
process and keeps the count, the newest entry and where every 1,024th line starts
(`CHANNEL_INDEX_EVERY`), and every append keeps them in step. A numbered channel's cursor is its
line's number, so a tail or an `after` says which line to begin after, and a read begins at the
block of lines that holds it, checking that each line up to the first one it gives has the cursor it
should (a place the index got wrong shows there, and is dealt with as below). A byte channel's
cursor is not a line's, and it is found by reading, which is cheap for a command's or a service's:
its log holds a few lines. A kind an extension adds with byte cursors that holds many is read from
its start for a tail or a cursor, and refused past what a request may read. A read gives what the
channel held when it began; an entry appended while it runs is for the next. Asking for what a
channel holds, or reading it, is the first thing a process does with its file, so it loads it: it
trims a line a crash cut off, and may write the index. The host's subscription takes `head()` first and reads only the entries it sends
(`readSelection`), so a client that reconnects with the cursor it last saw, or asks for a tail, does
not make the server read the channel.

**The index.** Reading the file to know all that costs a read and a check of every line, about 15
seconds a GiB, and a conversation that runs for weeks has gigabytes. A channel of at least one block
of lines, and numbered, therefore keeps `<channel>.idx` beside its log (`channelIndexSchema`; a byte
channel keeps none): how many lines the
log held, how many bytes those are, where the last of them starts and what it was, and where every
`CHANNEL_INDEX_EVERY`th line starts; a channel of a million entries has an index of about 15 KiB. It
is written whole or not at all, at the end of each block of lines, when the channel closes (so a
finished channel is covered whole) and after a load that had to read a block's worth of lines. A
process that reads the channel takes the index if the log still agrees with it: it is for blocks of
the same size, it is of a numbered channel, it covers no more than the log holds, it is consistent
(the last cursor is one less than its count), it is a regular file and the log has, where the index
says it ends, the entry and the bytes it says (so another channel's index is not taken: its last
line is not this log's). It then reads only the lines after it, which are at most a block. Anything
else (no index, a link to what is not a file, one too big to read into memory at 8 MiB, one that is
not valid, for another size, whose last line is not the log's) is the same as none: the log is read
whole and the index is made again. The offsets inside are not checked at the load, and a read that
begins at one checks the lines it passes. If a line is not the one it should be, or the place is in
the middle of a line, the log is read whole to find out why, with what the channel knows kept as it
is: if it is well formed the places were wrong, the ones that read made replace them, the index is
written again and the read starts over once; if it is not, the log is damaged, the places were not
at fault, nothing is replaced or thrown away, the read fails with that line named, and the log is not
read whole again for the next read that meets the damage (a process that starts again asks once more;
a read of the disk that failed is not damage, and is tried again). Reads that fail together on the
same places share one reading of the whole log. An index that hides lines or points into the middle of
one is found by the first read that begins there. A line's place is counted in the bytes the file has
(`readJsonLinesAt` reads bytes, and a line of text that is not UTF-8 is one replacement character to
the parser and still the bytes it is), so a damaged byte cannot put every later place wrong, which
would have made each read of the channel read the whole log and fail. It is a cache and never the record, so a write of it that fails costs the next process a read
of the log and never an append. What the index gives up is the check of every covered line at the load: a
log edited by hand inside what an index covers is found by the read that reaches the line (each
line a read returns is checked against its schema), not by the load, and the lines after the index
are checked as ever. The conversation's own channels are the one thing a reopen still reads whole
(`readStored` rebuilds the tree, and the usage, from them), so they are what a very long reopen
would spend its time on: the usage channel is an entry for each model call, a few hundred bytes
each.

**Limits.** A channel keeps at most 4 GiB, a conversation's channels at most 32 GiB together, and
a conversation at most 5,000 channels (`DEFAULT_CHANNEL_LIMITS`; an app may pass others to the
store). A conversation used for weeks keeps its story in one channel and a turn that reads files and
runs commands is tens of KiB of it, so these last months, not days; what to drop from the oldest end
is retention (#45), not a limit. An entry counts as its line, its JSON and the line break. They are counted from the files
once, so a conversation that is reopened carries on from what it holds, and kept by every append; an
entry is held for before it is written, with nothing awaited between the check and the hold, so
channels written at once cannot together pass a limit that each passes alone. An entry past a limit
is `quota` and is not written, after the files are counted again, since a write that failed in
another channel may still be held. That count is of what is on disk, so for that moment a line that
another channel has reserved and not yet written is not counted, and the limit can be passed by
the lines still being written, at most one per channel; it is only at a refusal that is about to
last. A channel that already holds entries then refuses every later
one, for good: it leaves a marker beside its log, `<channel>.full`, which a later process reads, so
a writer cannot leave a log that is missing an entry and go on (a byte channel's offset may jump,
so nothing else would stop it). The marker is read first when a channel is loaded. Until the marker
is written, every append tries again and fails if it cannot, so nothing is stored while the
process lives; if the disk never lets it be written and the process ends, the next finds no
marker, and the writer has been told `failed`. A channel with no entries has none missing: it
refuses that entry and leaves no marker, so refused names cannot pile up files. A reader is not
told that a channel is full: it reads what the channel holds. To take a channel up again, raise
its limits, delete its `<channel>.full` and restart: a running process keeps its refusal. A failed
write may have reached the file, so the channel reads it again, and the quota is set to what the
file really has, so a disk that keeps failing does not fill a channel's room with entries that were
never written. Only regular files are counted: a link is not a log the store made.

`FileConversationStore` and the in-memory fake in `@sheavly/testing` run one shared contract test
(`describeChannelLog`, `describeChannelLimits`), so a store that follows it follows the contract
another engine (a SQLite database, #246) is held to.

## Concurrency and crashes

- **One change at a time, in and across processes.** Every read-modify-write of a file (config,
  credentials, permissions, `DocumentFile`) goes through `LockedChange`: a `SerialQueue` for the
  callers in this process and a lock file (`<file>.lock`, `file-lock/`) for other processes on the
  same `~/.sheavly`. The lock is taken over when its process is gone or it is older than
  `LOCK_STALE_MS`, and a wait longer than `LOCK_WAIT_MS` fails naming the lock file. Permissions
  share one lock for their folder.
- **Append-only logs have one writer.** `stream.jsonl` and the history logs are not locked: a
  conversation belongs to the one process serving it, and a second writer would count its own
  `seq`. A refused or out-of-order append is how that would show.
- **Crash consistency is a write order, not a journal.** Decided for #272: no journal. Per
  conversation the stream is written first and is the source of truth; history, `log.jsonl`
  and the index follow, and each can be rebuilt or repaired from what precedes it on reopening
  (`interrupted` is computed on read, `log.jsonl`'s failures are replayed from the stream, a cut-off last
  line is trimmed). A crash can lose the newest derived write, never leave the files disagreeing
  in a way a reopen cannot repair.
- **A failed write is retried, never silently sticky.** `EntryLog` (runtime) and
  `ConversationKeeper` (host) keep what could not be stored at the front of their queue and write
  it first, in order, on `recover`. `Conversations.send` recovers before it refuses a prompt with
  `storage_failed`, so a disk that has mended is not held against the conversation. The first
  failed write also puts a `storage_failed` event on the stream (once per failure, never ending
  the run), so a UI can say the chat is not being saved before the next prompt is refused.
- **A damaged `config.json` names its path.** A start that must read it fails as `not_set_up`
  with the file in the message; a start on a named profile never reads it.

## The queue

`FileConversationStore.queue(id)` is a conversation's `queue.json`: the lines waiting in its queue,
`{ queued: string[] }`. It is a separate document from the history logs, so pending input never
reaches model input or a summary, and it survives a restart. Reopening a conversation reads it and
starts none of it until the next line is sent; the host's queue decides when a line becomes a
prompt. It shares the
`DocumentStore` wrapper with the shell state and is removed with the conversation.

## Shell state

`FileConversationStore.shell(id)` is a conversation's `shell.json`, beside its history logs: one
JSON document that its main session and sub-agents share. The harness keeps the agents' working
root in it (`@sheavly/workspace`'s `WorkingRoots`); storage holds no opinion about what is in it.
Every call for one id gets the same `DocumentFile`, so changes by several agents go through one
queue and never erase each other, and a write is atomic and private like the other files. It is
removed with the conversation. A write that arrives after `delete` still recreates the folder, as
the other files do; that is tracked in #241.

## What lives here

Everything the harness keeps for the user, under one root an app passes in (`~/.sheavly`): their
conversations, models, credentials, profiles and settings. Each kind of data gets its own store
over the same two functions, `readJsonFile` and `writeJsonFile`, so how a file is read and
replaced is decided once.

```text
~/.sheavly/
  config.json                            # profile bindings and global terminal preferences
  settings.json                          # global extension settings, written by hand
  trusted-workspaces.json                # shared: trust is about a repo, not a provider
  logs/backend.jsonl                     # the server's log: failures with no conversation
  permissions/<workspace-key>.json       # shared: what run_command may do in a folder
  profiles/<profile-id>/
    profile.json                         # identity, lastModelSelection and modelEfforts keyed by UUID
    settings.json                        # this profile's extension settings, written by hand
    models/<model-id>.json               # one file per model: { id, name, adapter, ...fields }
    credentials.json                     # { [model-id]: { apiKey } }, the only file with keys
    workspaces/<workspace-key>/
      conversations/<conversation-id>/        # one folder per conversation
        index.json                            # the index entry
        stream.jsonl                          # the stream, one entry per line
        history.jsonl                         # the main session's history log
        log.jsonl                             # the conversation log: stream failures and the backend's
        shell.json                            # working root shared by the agents
        queue.json                            # lines queued behind a running prompt
        outputs/                              # complete command output logs
        channels/<channel>.jsonl              # one channel's log: a node's, the tree's or usage's
        channels/<channel>.idx                # where its lines start, for a restart (a cache)
        agents/<session-id>.history.jsonl     # a sub-agent's history log
```

Everything on disk is named by an id, never by what a person typed (`<profile-id>` and
`<model-id>` are lowercase UUIDs; `<workspace-key>` is a hash of the workspace's real path). A
person's names (`work`, `Astra 6`) are inside the files, as labels.

`profile.json` stores the latest model/effort pair in `lastModelSelection` and the last effort of
each model in `modelEfforts`. `ProfileRegistry.rememberModel` writes both together, using the
profile write queue and atomic file replacement. Omitting an effort restores that model's previous
effort, or medium for a new model. Renames preserve both preferences, and profiles remain separate.
A key `profile.json` does not define, such as an old `lastModelId`, is dropped on read and not
written back. Stored conversation indexes keep their own `modelId` and `effort`, so resume does not
take another conversation's latest preferences.

Files written before "mode" became "effort" are read as the new form: `modelModes` and
`lastModelSelection.mode` in `profile.json`, `mode` in a conversation's `index.json`, and `mode` on
a session update and its session snapshot in `stream.jsonl` (`legacy-effort/`). Nothing rewrites
them on its own; a profile or index is saved in the new form the next time its store writes it,
and a stream, being append-only, keeps its old lines and is read this way every time. When both
keys are present the new one wins. A queue line (`prompt_started`, `prompt_refused`) written before
a queued line had a message id is read with a placeholder id, since nothing waits on a stored entry.
A reader outside the package (the terminal's replay) reads a stored stream line, or a workbook run's
`entry` frame, with `parseStoredStreamEntry`, which gives the entry in today's form or undefined; the
protocol's `streamEntrySchema` is the wire's and refuses the old forms.

**A tool outside the harness may read** `profiles/<profile-id>/profile.json` (its `id` and `name`)
and each conversation's `index.json` (the fields of `StoredConversation`: `id`, `title`, `modelId`,
`effort`, `workspace`, `profile`, `status`, `startedAt`, `updatedAt`), read-only, to list profiles
and their chats. Nothing else here is a contract: not the other files, not the rest of
`profile.json`, and not `<workspace-key>`, a hash of the real path that a reader finds by listing
`workspaces/`, never computes. Readiness and validation are the backend's (`GET /setup`).

Terminal preferences live in `config.json` under `terminal`: `reducedMotion` and `bell` are
optional booleans. Missing preferences mean animated activity and no terminal bell.
`ConfigStore.setTerminalSettings` replaces them through the same write queue as profile bindings.
Renaming, switching or deleting a profile does not change them. Missing preferences keep the
animated default.

- **A missing file is "nothing stored"; anything else wrong with a file is an error** that names
  it (`StorageFileError`). A store never starts from empty over a file it can't read: that would
  overwrite what the user has with the next write.
- **A write replaces the file whole.** It is written to a temp file beside it and renamed over it,
  so a crash or two writes at the same moment never leave half a file. The temp name is unique
  per call; a failed write removes it, and if that fails too both errors are reported.
- **Files are plain, flat JSON a person can edit.** That is why a read ignores a byte-order mark
  and accepts CRLF line ends, which Windows editors add.

## Every operating system

Linux, macOS and Windows are all supported, so a module here follows these rules. Each is
something that works on the system the code was written on and fails on another:

- **Modes are POSIX.** `PRIVATE_FILE_MODE` (`0600`) and `PRIVATE_FOLDER_MODE` (`0700`) keep the
  user's data to the user on Linux and macOS. Windows ignores them: there it is the permissions
  of the user's profile folder, where `~/.sheavly` lives, that keep others out. Never claim
  `0600` as the protection in a doc or a message; a test of a mode skips itself on Windows.
- **Windows refuses a rename while another program holds the file** (a virus scanner, an indexer)
  for a moment, with `EPERM`, `EBUSY` or `EACCES`. `replaceFile` tries again a few times; any
  write that replaces a file goes through it.
- **Names on disk come from ids, never from what a person typed.** A model's file is its
  lowercase UUID (`<uuid>.json`): it has no character a file name can't hold, no reserved name
  (`CON`, `NUL`, `COM1`), and no case, so macOS and Windows (case-insensitive) and Linux
  (case-sensitive) agree on which file it is. A name that has to come from something else (a
  workspace's folder) is made from a hash of its real path plus a readable part cut to a few
  characters, never the path itself: a path holds `:`, `\` and `/`, and a long one passes
  Windows' 260-character limit.
- **Paths are built with `node:path`**, never by joining with `/`, and a path kept in a file is
  not compared as text across systems (`C:\Users\x` and `c:\users\x` are one folder).
- **The home folder is `os.homedir()`**, never `HOME`, which doesn't exist on Windows. `sheavlyHome`
  (`home/`) is the one place that picks the user's folder: `SHEAVLY_HOME` (an empty one counts as
  not set), else `.sheavly` in that home. A store takes the root it is given and never reads env.
- **Sorting does not use the system's locale.** `readdir` lists in the system's order and a
  default `Intl.Collator` follows the machine's language, so the same profile would list
  differently on two machines. A listing sorts file names by code and labels with a fixed locale.
- **A folder holds litter.** `.DS_Store` and `._*` files (macOS), `Thumbs.db` and `desktop.ini`
  (Windows), `*~` and `.swp` files (editors). A store reads only what it names: `<id>.json`, and
  nothing hidden.

## The model store

Optional `identity: { model, family? }` records the model chosen in setup, independently of its
display label and hosting deployment. It belongs in the file's envelope, like pricing, and never
enters the adapter definition. Existing files without it read unchanged; there is no implicit
identity inference or migration. The choice does not certify which weights a cloud deployment serves.

A model may include `pricing` alongside its identity, with `input`, `output`, `cacheRead` and
`cacheWrite` in USD per million tokens. It is envelope metadata, not an adapter definition or a
secret. Usage and cost estimates are stored as stream entries, so reopening a conversation uses
its recorded costs rather than recalculating them with newer rates.

A model may also include `contextWindow`, its context size in tokens, in the same envelope. It is
read and written like `pricing` and never enters the adapter definition. A file without it reads
unchanged; the host decides what window a model without one is told.

`ModelStore` is a profile's `models/` folder, one `<model-id>.json` each, flat so a person can
read and edit it. It is the pattern a store of hand-editable files follows:

- **`list()` never fails over one bad file.** It returns the models that read cleanly and a
  problem for each file that did not (damaged, not what a model is, or an `id` that isn't its
  file's name), each naming the file. People edit these files; a typo in one must not take the
  others down, and must not be silently skipped either.
- **`get(id)` fails for a bad file.** Asking for a model that exists but can't be used must not
  look like asking for one that isn't there.
- **A file is its id.** `<id>.json` holds the model with that `id`; a copy made by hand keeps the
  old `id` inside, so it is refused, not served as a second model under a new name.
- **A key never goes through it.** The store has no adapter and can't tell a key from a field;
  `AdapterRegistry.validateDefinition` refuses one first, and credentials have their own store.

## The credential store

`CredentialStore` is the only file with keys in it (`credentials.json`, `{ [model-id]: { [field]:
value } }`, the field names being whatever the adapter calls its secrets). It is built so a mistake
here cannot become a leak:

- **A key is never in an error.** Node's own message for a file that is not JSON quotes the text
  around the fault, which in this file could be a key; for it the message is fixed and carries no
  `cause`. A file of the wrong shape is named by the path of the field only.
- **A file open to others is refused**, as `ssh` refuses a key file: the keys in it may already
  have been seen, so the message says to restrict it (`chmod 600`) and to replace them. It is left
  as found. Where the system has no modes (Windows) nothing is checked, and the protection is the
  user's profile folder.
- **Our own writes are always private.** The file is made `0600` in a `0700` folder, and a
  replace keeps it so.
- **Writes are queued and locked** (`LockedChange`). Setting a key reads the file and writes it
  back whole, so two at once, here or in another process, would start from the same file and the
  second would erase the first's key. A write that fails does not hold up the ones after it.
- **Nothing can overwrite a file that can't be read.** A write reads first, so a damaged or open
  file stops it instead of being replaced by one holding a single key.
- **`fieldsSet()` says which fields are set, not their values**: all a UI needs to show "a key is
  set", with no way to read it back.

## The config store

`ConfigStore` is `config.json` at the root: `{ defaultProfile, workspaces: { <workspace-key>:
<profile-id> } }`, ids only. A workspace not bound uses the default; with neither, `profileFor`
says `undefined`, which is what onboarding is for.

- **A workspace key is a hash of its real path**, so it can name a folder on any system.
  `workspaceKey` lowercases a Windows path and makes its separators alike (`C:\Users\X\Proj`,
  `c:\users\x\proj\` and `C:/Users/X/Proj` are one folder), and keeps case elsewhere. Its value
  is pinned in a test against `sha256sum`: changing it would orphan every stored conversation.
- **Config never points at a profile that is gone.** `forgetProfile` takes a deleted profile out
  of the default and every binding. It touches config only: a profile's keys, models and
  conversations are inside its own folder, so deleting the folder deletes them.
- **Changes are queued and locked** (`LockedChange`), as for credentials, and a file that can't be
  read stops a change instead of being replaced.
- **`workspaceKey` is the one key function.** Profile bindings key a workspace's real path with
  it, and permissions key the real path of the repo's main worktree with it (the backend's
  `permissionRoot`, so every worktree shares one mode). Trust (`@sheavly/workspace`) is keyed by
  the real path per worktree, since a worktree's `.sheavly/` can differ. These scopes differ on
  purpose; what must not differ is how a path becomes a key, which is here.

## The permission store

`PermissionStore` is `permissions/<workspace-key>.json` under the root: `{ root, mode, allow }`
for one workspace, where `mode` is `ask`, `always_ask` or `allow_all` and `allow` the commands the
user allowed for good (`git log *`). It is not under a profile, since a folder's permissions are
the same whichever profile runs in it, and never in the repo, where the agent could edit it.
Nothing stored is `ask` with nothing allowed, and reading writes nothing.

- **A file is trusted only under its own name.** The name is the hash of `root`, so a file copied
  to another workspace's name is refused, not read as that workspace's grants.
- **A write can't make a file the next read refuses.** The result is checked against the schema
  first (no empty entry, no entry starting with `*`), and a file that can't be read stops every
  change instead of being replaced.
- **Changes are queued and locked** (`LockedChange`, one lock for the folder) and read the file
  fresh, so a mode set while conversations run applies to their next command.

## The profile store

`ProfileStore` is the `profiles/` folder: one `<profile-id>/` folder each, with a `profile.json`
(`{ id, name }`) and everything of that profile inside, its models, its keys and its conversations.
It lists the way the model store does (a folder it cannot use is reported by name and the rest
load; see `listing/`), and a folder is its id, so a copy made by hand is refused.

- **Deleting a profile deletes its folder.** That is what keeping a profile's keys inside it buys:
  nothing of a deleted profile is left on disk, with no list of what to clean up. `remove` is
  retried while another program holds a file in it (Windows). It tells the config nothing: the
  caller also calls `ConfigStore.forgetProfile`.
- **A delete is bounded by its id.** The folder is `profiles/<id>` and an id is parsed as a UUID
  before it is a path, so nothing that could name another folder reaches `rm`. A link is removed as
  the link, never emptied through, and no link inside the profile is followed out of it. A profile
  folder that is a link is listed, since a profile kept in a synced folder is one.
- **Hidden folders and files are not profiles.** `.git`, `.Trash`, `.DS_Store`, `Thumbs.db`.

## The profile registry

`ProfileRegistry` is the one door to all of this: the profiles, the config and each profile's
models and keys. The backend uses it and not the stores under it, because the stores each do one
thing and don't keep each other in step: removing a model through `ModelStore` leaves its key
behind, and deleting a profile folder leaves the config naming it.

- **`delete(id)` forgets the config first, then removes the folder.** If the folder can't be removed
  the profile is still there, unbound, and deleting it again finishes the job. The other order
  could leave the config naming a profile that is gone. `profileFor` also falls back from a
  profile whose folder was deleted by hand, so a workspace is never left with nothing to use.
- **`setDefaultProfile` and `bindWorkspace` check the profile inside the same queue as `delete`**,
  so a delete cannot land between the check and the config write and leave config naming it.
- **`open(id)` returns one `OpenProfile` per profile.** Its credential store queues writes in memory,
  so two on one file would erase each other's keys; the registry is what guarantees one, even for
  two opens at the same moment.
- **An open profile keeps a model and its key together.** `removeModel` removes the key first (a
  failure then leaves a model without a key, not a key for nothing), `putSecrets` refuses a model
  the profile doesn't have, and every write checks the profile still exists, so one deleted in the
  meantime is not recreated as a folder holding one key. That check is not atomic with the write; a
  folder left by a delete landing in between is listed as a problem, and deleting it clears it.
- **It is a key holder.** `getSecrets` hands a key to whoever asks, so `harness/no-key-holder-import`
  keeps its import to the backend app, exactly as for the credential store.

## The settings files

`SettingsFiles` reads the user's two own settings files: `settings.json` at the root (global) and
`profiles/<profile-id>/settings.json`. They are written by hand, so nothing here writes them. Each
read returns `{ text, file }`, or `undefined` for a file that is not there, which is an empty layer
(a profile with no folder included: that the profile exists is the registry's to say). The text is
not parsed: the setting grammar belongs to `@sheavly/extension`, which storage sits below and must
not import, so the caller parses it with `file` as the source of its messages.

- **A file that cannot be used is a `StorageFileError`** naming the file and the reason, never its
  content: it is a folder or another kind of file (refused before opening: a FIFO that is there
  when the file is examined cannot block the read; a regular file swapped for a FIFO between the
  `stat` and the read is not covered, since only the user's own folder can do that), it is over `MAX_SETTINGS_FILE_BYTES` (64 KiB, the same figure as the settings file
  contract, defined here because the contract is above storage), it cannot be read, or it is not
  valid UTF-8. The file is read once.
- **A profile id is checked as a profile id** (a lowercase UUID) before a path is made, so `..`, a
  separator, an empty or absolute value throws an `UnsafePathError` and nothing is read.
- **`ProfileStore` does not look at it.** `list()` reads only each folder's `profile.json`, so a
  `settings.json` beside it is neither a problem nor a profile, and `remove` deletes the profile's
  folder whole, the settings file with it.

## The discovery file and the server's presence

`discovery-file/` holds `server.json`, the file a running server writes so clients on the machine
find it (where it listens, the token that opens it, which instance it is), in the runtime folder
`serverRuntimeDirectory` chose, beside the lock socket. Its shape is the protocol's
`discoveryFileSchema`. It holds a token, so it is its own module and does not use `writeJsonFile`.

- **Writing** (`publishDiscoveryFile`): the folder must pass `checkPrivateDirectory`, a value the
  schema rejects or that would not fit the reader's cap is refused before anything is written, and
  a folder at the target is refused. Any other entry there (a link, a FIFO, a socket) is replaced
  by the rename, which never follows a link, so a stale one cannot keep the server undiscoverable.
  The value is written to `server.json.<pid>.<id>.tmp` made with `O_EXCL` (a planted link fails,
  never followed), flushed, set to 0600 through the open handle (so a umask can neither widen nor
  strip the mode) and renamed over the final name: a reader sees a whole file or none. A failure
  removes the temp file only if this call made it. A sweep first removes the temp files of
  publishes whose process no longer runs (a pid outside 1..4194304 counts as not running), and
  `removeDiscoveryFile` sweeps the same way, because a crash can leave a 0600 temp file holding
  the token. The result is a value (`published`, `refused`, `failed`); no message holds the token.
- **Reading** (`readDiscoveryFile`) is the mirror, and the only way to read it: the same folder
  check, then `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO is refused, not waited on), then the checks
  on the open handle (a regular file, ours, closed to others, at most `DISCOVERY_MAX_BYTES`), so
  nothing can be swapped between check and read. A later `formatVersion` is `newer`, anything else
  that does not parse is `invalid`; no result but `found` holds the file's text or the token.
  Searching several folders and proving the holder is alive is `findRunningServer`, below.
- **Removing** (`removeDiscoveryFile`) reads the file the safe way and deletes it only when its
  `instanceId` is the caller's: a successor's file stays. The read and the delete are two steps,
  so a successor that publishes between them loses its file; that is reachable only after a crash
  takeover, because removal runs before the lock is released.
- **`ServerPresence`** is the lifecycle a backend calls: `claim` (the runtime folder, then the
  lock), `publish` (only while the lock is held), `remove` (only our own file), `release`. Only a
  `held` claim should stop a server; a folder or lock that cannot be used, and any failure to write
  or remove the file, is a warning through `log`, and a method never rejects. `release` waits for a
  claim still in flight and closes the instance: a later `claim` answers `unavailable` without
  acquiring anything. `held` carries a `FirstServer` (pid, url, version, never the token) for
  `describeHeld`'s message, which prints only the server's origin, never a login, path or query.

### Finding the running server

`server-finder/` is the other side of the file: `findRunningServer` finds the server of a home
without a URL or a token, and reads and probes only (it creates, changes and removes nothing).

- **Candidates** (`serverRuntimeCandidates`, in `server-runtime/`): the folders a server of the
  home may have published in, in the order a client looks: `$XDG_RUNTIME_DIR/sheavly/<hash>` when
  the variable is an absolute path, then the home folder (by its real path). It creates, checks
  and changes nothing, and a home that does not exist yet is listed by its absolute path; the
  reader judges each folder.
- **The probe** (`probeServerLock`, in `server-lock/`): connects to the lock socket of that folder
  and returns `held` (accepted), `free` (refused or missing: the process is gone) or
  `inconclusive` (a timeout or any other error). It reuses the lock's own connect and never
  listens or unlinks, so it is safe on a live server's socket. The Windows named-pipe branch is
  written and not tested, like the lock's.
- **The finder**: per candidate it reads the file with `readDiscoveryFile`; if that is not
  `found` it records why and goes on. A `found` file with a `free` lock is stale and one with an
  `inconclusive` lock is doubtful: both are recorded and the handshake is never called, so no
  token is handed out on doubt. A `held` lock calls `verify`, which is passed in because a library
  package may not depend on `@sheavly/client` (an app passes `verifyServer`; the finder's types
  mirror its `VerifyResult`, and a test in the backend fails if they drift). `verified` returns
  `found`, the only result with the token; `version_mismatch` is remembered while the next
  candidate is tried and returned when none verified; `wrong_server` and `no_handshake` are
  recorded; a handshake that throws or does not settle within `timeoutMs` (5 s unless set; it is
  also handed an `AbortSignal`) is recorded as `no answer`, by its error's class name alone and
  only for a short allow-list of names (any other is "an unknown failure"). An answer that is not
  one of the four shapes (`undefined`, a non-object, an unknown status, a missing field, a text
  that quotes the token) is read as `no handshake`, and a `version_mismatch` is rebuilt from its
  four fields, so nothing else a handshake returned is copied. `none` carries one `Reason` per
  candidate (a folder and a typed problem with a message), and `describeNone` renders them as
  lines for a CLI. No reason, message or log line holds the token or the file's text, whatever
  the injected `verify` answers or throws; tests check this for a handshake that lies, and for
  every non-`found` result with a known token.
- **What it does not decide**: the URL's host is not restricted. A file in the user's own private
  folder is the user's own data, and the always-on server may bind elsewhere, but the finder hands
  the token to a caller who will send it to that address: a hostname there is open to DNS
  rebinding and a remote host would receive later token-bearing requests. Only the user can write
  the file (the folder is owner-only).
- **Limits**: when two servers of one home are both live (the runtime-directory limit above) the
  first candidate, the runtime folder, wins. A plain file, a directory, a FIFO or a dangling link
  at the lock socket path reads as `free`, so a file there is called stale. A runtime path too
  long for a socket makes the probe `inconclusive`: a server in that state runs without a lock
  and is not found; there is nothing to do yet but a shorter home path. A server whose process is
  stopped (SIGSTOP) still accepts into its backlog, so the lock reads held and the handshake then
  times out after 5 s: `none` with `no answer`, and no token sent. A graceful stop leaves empty
  `sheavly/<hash>` folders (no files) in the runtime directory. The worst case of a call with two
  candidates is about 2 × (1 s probe + 5 s handshake) = 12 s, shortened by `timeoutMs`.

## Adding a store

A store is a module folder here (`<kind>-store/`), a class over a root folder it is given. It
reads and writes through `json-file/`, names its files from ids, and says in its test what it does
when a file is missing, damaged or being replaced. Add its row to the README, and export its file
kind with `npm run export -- packages/storage <kind>` if it has none yet.

## Naming and deleting

A store never builds a path from an id by hand, and nothing here calls `rm` itself. Every path a
store reads, writes or deletes comes from `safe-path/`, which checks what it was asked for before it
touches the disk. A recursive delete with a wrong path (an empty one, a variable that was never set,
an id that is really `../x`) is not undone, and a write to one overwrites a file; the same bug that
makes one dangerous makes the other, so they share the rules. Each throws an `UnsafePathError` and
touches nothing when:

- **The name is not an id.** `namedPath` makes the path of `<id><extension>` in a folder, and only a
  lowercase UUID and a plain extension (`.json`) pass, so nothing holds a separator, a `..`, a glob
  or a reserved name, whatever the type of the value says: a type is not proof for a value that
  came from outside. Reads, writes and deletes of a model or a profile all name their file this way.
- **The root is not a place for a store.** A store checks the folder it is given when it is built
  (`assertSafeRoot`): a relative one would silently mean wherever the process runs, so the same
  store would read and write somewhere else after a `cd`; the top of a file system is no place
  for our files.
- **The place is not the store's own** (deleting a folder). `removeFolder` takes only a folder
  directly inside the store's folder (`profiles/<id>`), never the store's folder, a folder above
  it, a relative path, the home folder, or the folder that holds it. The path is resolved first
  (`..` applied), and what is checked is what is deleted. A store folder reached through a link
  must not really be the top of a file system.
- **It is not the kind of thing asked for.** `removeFile` is never recursive, and leaves a folder
  with that name alone.

`writeJsonFile` and `appendJsonLine` take any path by design (the config and the trust document
have a fixed name and no id in it); their callers choose the path, and a store chooses it with
`namedPath`. The one other `rm` is `writeJsonFile` discarding the temp file of a write that failed: a
non-recursive remove of `<file>.<uuid>.tmp`, a name that function made itself a moment before, so it
can't name anything else. The test helpers' `rm` removes a folder the test just made. The tests of
this module hold the rules: each was broken on purpose to see a test fail.

Tests run in a temp folder and never touch the real `~/.sheavly`. CI runs on Linux only today;
Windows and macOS behaviour here rests on documented behaviour of the platform, so a change to a
rule above deserves a run on that system.
