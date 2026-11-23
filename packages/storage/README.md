# @sheavly/storage

The user's data on disk: the folder layout under `~/.sheavly`, file-backed stores for
conversations, models, credentials and profiles, and the one atomic JSON write they share. Generic:
it knows nothing about files in a workspace or about code. A store never reads env: an app passes
the root in, and `sheavlyHome(env)` is the one place that says which folder that is.

```ts
import { readJsonFile, writeJsonFile } from '@sheavly/storage/json-file/json-file.helper';

await writeJsonFile({ file: path.join(root, 'config.json'), value: { profile: 'work' } });
const config = await readJsonFile({ file: path.join(root, 'config.json'), schema }); // or undefined
```

| Module                | What it holds                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `json-file/`          | `readJsonFile`, `writeJsonFile`, `writeTextFile`, `removeTextFile`: a typed read, atomic private writes, on Windows too     |
| `model-store/`        | `ModelStore`: a profile's models, one `<model-id>.json` each; a bad file is reported, the rest load                         |
| `credential-store/`   | `CredentialStore`: a profile's keys in one private file; never in an error, never read if open to others                    |
| `config-store/`       | `ConfigStore`: profile bindings and global terminal preferences; `workspaceKey` hashes a real path                          |
| `permission-store/`   | `PermissionStore`: what `run_command` may do in each workspace, a file each under `permissions/`                            |
| `conversation-store/` | `FileConversationStore`: a workspace's conversations, a folder each with its stream, history and index                      |
| `output-store/`       | `FileOutputStore`: a conversation's complete command output, one private log file per command                               |
| `document-file/`      | `DocumentFile`: one JSON document in one file for an owner with its own schema; changes go one at a time                    |
| `profile-store/`      | `ProfileStore`: the profiles, one `<profile-id>/` folder each; deleting one deletes everything in it                        |
| `profile-registry/`   | `ProfileRegistry`: profiles, config and each profile's models and keys, kept in step (the backend's door)                   |
| `settings-file/`      | `SettingsFiles`: the text of the user's `settings.json`, global and per profile, edited by hand                             |
| `home/`               | `sheavlyHome`: the user's folder, `SHEAVLY_HOME` or `~/.sheavly`, from an environment                                       |
| `server-runtime/`     | `serverRuntimeDirectory`: the one private folder for the server's socket and file; `serverRuntimeCandidates`: where to look |
| `server-lock/`        | `acquireServerLock`: one server per home, a held socket; `probeServerLock`: look at it without changing it                  |
| `discovery-file/`     | `server.json` (publish, safe read, remove) and `ServerPresence`: the lock and the file, warnings only                       |
| `server-finder/`      | `findRunningServer`: read, probe and verify (an injected handshake) before the token is handed out                          |
| `listing/`            | `FileProblem`: a stored file that was skipped and why, which a listing reports and does not hide                            |
| `errors/`             | `StorageFileError`: a stored file that can't be read, parsed, validated or written                                          |

Internal (closed in `exports`): `safe-path/` (`namedPath`, `assertSafeRoot`, `removeFile` and
`removeFolder`: every path a store makes, reads, writes or deletes is checked there), `serial-queue/`
(`SerialQueue`, one change at a time, and `LockedChange`, the one read-modify-write primitive every
store uses: a queue in the process plus a lock file across processes), `file-lock/` (the lock
file behind it), `jsonl-file/` (append and read a stream's lines) and `legacy-effort/` (reads a
`profile.json`, conversation `index.json` or `stream.jsonl` written before "mode" became "effort";
the stores save a profile or index in the new form).

Runs on Linux, macOS and Windows; see [Design](docs/design.md#every-operating-system) for what that
asks of every module here.

## Docs

Each kept chat gets a private `errors.jsonl` beside its history and stream when a run, hook or tool
fails. Records include conversation, session and originating user-message IDs, timestamps, stream
sequence and relevant tool-call IDs. Run errors include a bounded stack and cause chain. Prompts,
tool inputs and successful outputs are not copied. Common credential forms in exception text are
redacted. The first write after reopening repairs missing diagnostics from the authoritative stream.

Complete command output (`ConversationStore.outputs(id)`, `FileOutputStore`) is kept under
`<conversation>/outputs/<output-ref>.log` (the bytes as captured, stdout and stderr in arrival order)
with `<output-ref>.json` written when the capture ends. A reference is a UUID, never a path, and a
store only opens its own conversation's folder, so another conversation's reference is `not_found`.
Retention: a log lives as long as its conversation, so it survives a reopen and a summary, and goes
when the conversation is deleted; nothing else removes it. Deleting a conversation first ends its
running captures and refuses new ones, so a command still printing cannot recreate the folder.
Capture never blocks the command and holds at most 8 MiB waiting for the disk; a log keeps at most
128 MiB, and one conversation at most 1 GiB and 5,000 logs, counted from what is already on disk
when the conversation is reopened. Past a size limit, or after a failed write, the log is marked
`incomplete` with the reason and later output is dropped, so a partial log is never shown as whole.
Past the log count a new command still runs, and its result says its full output is not stored.
Closing a log waits at most 5 seconds for queued writes: a stalled disk marks it `incomplete` (the
end may be missing) instead of holding the task or a cancel. A log with no final record (the
process died mid-capture) is reported `incomplete`. Reads are by byte range and search is a literal
scan in bounded windows, so neither holds a whole log in memory.

- [Design](docs/design.md): how it works, and how to extend it.
