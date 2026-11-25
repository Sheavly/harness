// Conventions written as AST selectors, each under its own rule ID, so a
// `files:` override can switch one off without restating the others.

const PARAMS_OBJECT_MESSAGE =
  'Functions with more than one input take a single `params` object, destructured on the first line: `function f(params: { a: A; b: B }) { const { a, b } = params; }`.';

/** Modules that read or write the terminal. */
const TERMINAL_MODULES = '/^(node:)?(readline|tty)(\\u002Fpromises)?$/';
const STDIO = '/^(stdin|stdout|stderr)$/';
const TERMINAL_IO_MESSAGE =
  'No terminal I/O (node:readline, node:tty, process.stdin/stdout/stderr) outside an app: the harness emits typed events and a UI renders them. A UI is an app in apps/ (`npm run new -- app <name> …`), built only when its issue asks for one; a package that formats output takes a write function from the app instead.';

/**
 * The modules that read and write files. Imported by name (`import { writeFile } from
 * 'node:fs/promises'`) the functions are visible; as a whole (`import fs`, `import('node:fs')`)
 * they are not, so those are banned where writing is.
 */
const FS_MODULES = '/^(node:)?fs(\\u002Fpromises)?$/';
/** The functions that create, change, move or delete a file or folder (`open` can write). */
const FS_MUTATORS =
  '/^(writeFile|appendFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|cp|copyFile|createWriteStream|truncate|ftruncate|symlink|link|chmod|chown|utimes|open|write|writev)(Sync)?$/';
const FILE_WRITES_MESSAGE =
  "Do not write, move or delete files by hand. The user's data goes through `@sheavly/storage` (`writeJsonFile`, `appendJsonLine`, `DocumentFile`, the stores): atomic, private, retried on Windows, and the path is checked. The agent's file tools change a project's files through `extensions/coding/src/files/files.helper.ts` (`resolveWritable`, `resolveDeletable`, `createParentFolder`, `writeText`, `removeFile`), which resolve through `Workspace`, its file locks and the `.env`/`.git` guards. A justified exception is a `files:` override with a reason, in this workspace's eslint.config.js.";

/**
 * The credentials file as the last part of a path, in any case (macOS and Windows file systems
 * ignore it, so `Credentials.JSON` is the same file): the whole string, or what follows a `/` or
 * `\`. A message that only mentions the name in a sentence is not a path and is not matched.
 */
const CREDENTIALS_PATH = '/(^|[\\\\\\u002F])credentials\\.json$/i';
/** The runtime-directory variable and the discovery file's name, anywhere in a string. */
const DISCOVERY_NAMES = '/XDG_RUNTIME_DI[R]|server\\.json/';
/** The variable as an identifier: `process.env.<name>` or `const { <name> } = env`. */
const RUNTIME_VARIABLE_NAME = '/^XDG_RUNTIME_DI[R]$/';
/**
 * The modules that hand out keys, imported by package subpath: the credential store itself, and
 * the profile registry, whose open profiles read and set them. Whatever can import either can
 * read a key, so both are on this list.
 */
const KEY_HOLDER_MODULES =
  '/^@sheavly\\u002Fstorage\\u002F(credential-store|profile-registry)\\u002F/';

/** The helper that appends instruction context, by path or package subpath, `.js` or not. */
const INSTRUCTION_CONTEXT_MODULE = '/(^|\\u002F)instruction-context\\.helper(\\.js)?$/';

/** The factory and its types: importing either makes a file an instruction source. */
const INSTRUCTION_SOURCE_MODULE = '/(^|\\u002F)instruction-source\\.(helper|types)(\\.js)?$/';

/** The SSE reader, by path or package subpath, `.js` or not. */
const SSE_READER_MODULE = '/(^|\\u002F)sse\\.utils(\\.js)?$/';

export const SYNTAX_RULES = {
  'no-default-export': [
    {
      selector: 'ExportDefaultDeclaration',
      message: 'Use named exports, so imports and renames stay greppable.',
    },
  ],
  'no-process-env': [
    {
      selector: "MemberExpression[object.name='process'][property.name=/^(env|loadEnvFile)$/]",
      message:
        'Read env only in an app (apps/*): it loads `.env` and passes `process.env` in (`createCodingExtension({ env })`). A package takes the values, or an `Environment` (`@sheavly/core/environment/environment.types`), as options; it never reads env itself.',
    },
  ],
  // Only module-level functions: inline callbacks (`.map((x, i) => ...)`) and class methods
  // have signatures their caller dictates.
  'params-object': [
    { selector: 'FunctionDeclaration[params.length>1]', message: PARAMS_OBJECT_MESSAGE },
    {
      selector:
        ':matches(Program > VariableDeclaration, Program > ExportNamedDeclaration > VariableDeclaration) > VariableDeclarator > :matches(ArrowFunctionExpression, FunctionExpression)[params.length>1]',
      message: PARAMS_OBJECT_MESSAGE,
    },
  ],
  // The harness is a backend: it emits typed events and registries, and renders nothing. Only an
  // app (a workspace in apps/) is exempt; `baseConfig` reads that from where it is.
  'no-terminal-io': [
    {
      selector: `ImportDeclaration[source.value=${TERMINAL_MODULES}], ImportExpression[source.value=${TERMINAL_MODULES}]`,
      message: TERMINAL_IO_MESSAGE,
    },
    {
      selector: `MemberExpression[object.name='process'][property.name=${STDIO}]`,
      message: TERMINAL_IO_MESSAGE,
    },
    {
      selector: `ImportDeclaration[source.value=/^(node:)?process$/] > ImportSpecifier[imported.name=${STDIO}], VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name=${STDIO}]`,
      message: TERMINAL_IO_MESSAGE,
    },
  ],
  // Dates are Luxon's, and the current time is read in one place, `now()`
  // (`@sheavly/core/clock/clock.helper`): a timestamp is epoch milliseconds from it, and a test
  // fixes it with `useFixedClock`. Tests follow the same rule: they build dates with Luxon too.
  'no-direct-clock': [
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
      message:
        'Read the time with `now()` (`@sheavly/core/clock/clock.helper`), not `Date.now()`: it is the one place the clock is read, so a test can fix it (`useFixedClock` from `@sheavly/testing/clock/fixed-clock.fake`). To time how long something took, use `performance.now()`.',
    },
    {
      selector: "NewExpression[callee.name='Date']",
      message:
        'Use Luxon (`DateTime`) for dates, or `now()` (`@sheavly/core/clock/clock.helper`) for the current time as epoch milliseconds, not `new Date()`: one clock, so a test can fix it and a timestamp is always a `timestampSchema` value.',
    },
    {
      selector: "CallExpression[callee.object.name='Date'][callee.property.name=/^(UTC|parse)$/]",
      message:
        'Use Luxon for dates: `DateTime.utc(2026, 11, 2).toMillis()`, not `Date.UTC` / `Date.parse`. Times are stored and sent as epoch milliseconds (`timestampSchema`); format one for a person with `DateTime.fromMillis(at).toFormat(...)`.',
    },
    // A time is epoch milliseconds everywhere it is stored or sent, so no code writes or reads an
    // ISO 8601 string: a second format means a second parser, and files that disagree.
    {
      selector:
        'CallExpression[callee.property.name=/^(toISOString|toISO|toISODate|toISOTime|fromISO|fromISODate)$/]',
      message:
        'Times are epoch milliseconds (`timestampSchema`), never ISO 8601 strings: keep the number, and format it for a person only at the edge with `DateTime.fromMillis(at).toFormat(...)` or `.toLocaleString(...)`.',
    },
    {
      selector: "MemberExpression[object.name='z'][property.name='iso']",
      message:
        'Times are epoch milliseconds (`timestampSchema` from `@sheavly/protocol/time/time.validator`), never ISO 8601 strings, so a schema takes no `z.iso.*`.',
    },
  ],
  // The credentials file holds every model's key. Reading it is `CredentialStore`'s job and the
  // backend's alone (which serves it to nobody): the store checks that the file is private, never
  // puts a key in an error and queues writes, none of which code that opens the file itself does.
  // So no other code names the file, or imports the module that does.
  'no-credentials-file': [
    {
      selector: `Literal[value=${CREDENTIALS_PATH}], TemplateElement[value.cooked=${CREDENTIALS_PATH}]`,
      message:
        'Do not name the credentials file (`credentials.json`). Keys are read and written through `CredentialStore` (`@sheavly/storage/credential-store/credential-store.service`), which refuses a file others can read and never puts a key in an error. Only the backend app uses it; any other code asks the backend (a UI) or is given the secret it needs as an option.',
    },
  ],
  'no-key-holder-import': [
    {
      selector: `ImportDeclaration[source.value=${KEY_HOLDER_MODULES}], ImportExpression[source.value=${KEY_HOLDER_MODULES}]`,
      message:
        "Only the backend app (apps/backend) imports the credential store or the profile registry: it is where a key is read and handed to a provider. Other code never holds a key: a UI sets one through the backend's API, and a package is given what it needs as an option. In the backend, turn this rule off for the one module that holds keys, with a `files:` override and its reason in apps/backend/eslint.config.js.",
    },
  ],
  // The folder where the server holds its lock and publishes its discovery file is resolved in one
  // place, `serverRuntimeDirectory`: it reads the runtime-directory variable, checks that the
  // folder is private and falls back to the home. A second reader of that variable, or a path
  // built to the discovery file by hand, finds another folder and talks to no server or the wrong
  // one. A string or template piece that merely contains either name fails too (`<name>.tmp`
  // would still resolve the path). Not covered: a name split across pieces or held in a variable.
  // The regexes are spelled so this file does not contain the names it forbids.
  'no-discovery-path': [
    {
      selector: `Literal[value=${DISCOVERY_NAMES}], TemplateElement[value.cooked=${DISCOVERY_NAMES}], Identifier[name=${RUNTIME_VARIABLE_NAME}]`,
      message:
        "Do not name the runtime-directory environment variable or the discovery file. Where the server's lock and discovery file live is resolved once: `serverRuntimeDirectory` (`@sheavly/storage/server-runtime/server-runtime.helper`) reads the variable and checks the folder, and `@sheavly/storage/discovery-file/*` (`readDiscoveryFile`, `publishDiscoveryFile`) owns the file; the file's name is `DISCOVERY_FILE_NAME` (`@sheavly/protocol/discovery/discovery.constants`). Import them instead of rebuilding the path.",
    },
  ],
  // Files are written in one place. The user's data (conversations, models, trust, config) goes
  // through `@sheavly/storage`, which writes atomically and privately, retries on Windows and
  // checks every path; the agent's file tools write a project through `Workspace`. A hand-rolled
  // write elsewhere is how a trust file ended up with a temp name two writes could share.
  'no-direct-file-writes': [
    {
      selector: `ImportDeclaration[source.value=${FS_MODULES}] > ImportSpecifier[imported.name=${FS_MUTATORS}]`,
      message: FILE_WRITES_MESSAGE,
    },
    {
      selector: `ImportDeclaration[source.value=${FS_MODULES}] > :matches(ImportNamespaceSpecifier, ImportDefaultSpecifier)`,
      message: `${FILE_WRITES_MESSAGE} Import what you read by name (\`import { readFile } from 'node:fs/promises'\`): a whole-module import hides what is written.`,
    },
    {
      selector: `ImportExpression[source.value=${FS_MODULES}]`,
      message: `${FILE_WRITES_MESSAGE} Import what you read by name: a dynamic import hides what is written.`,
    },
  ],
  // A harness notice reaches a model through `formatHarnessNotice`, which owns the envelope: its
  // origin line, its handling policy, and the escaping of what is inserted inside it. Text built
  // by hand skips all three, so a report or a tool's output could close the envelope early. Lint
  // catches the accident: a string or template piece holding `harness-notice` (even without a
  // bracket, so a path or label of that name is flagged too) or `<harness`, `</harness`. It cannot
  // see a tag split inside a word or built from a variable, so the formatter's escaping and its
  // tests carry the guarantee.
  'no-handwritten-notice': [
    {
      selector:
        'Literal[value=/<\\/?harness|harness-notice/i], TemplateElement[value.cooked=/<\\/?harness|harness-notice/i]',
      message:
        'Do not write a `<harness-notice` envelope by hand. Add the notice as a kind of `harnessNoticeSchema` (`@sheavly/protocol/notice/notice.validator`) and format it in `formatHarnessNotice` (`@sheavly/core/notice/notice.utils`), whose wording lives in `notice.constants.ts`: it frames the text as harness data, not a user message, and escapes what is inserted inside it.',
    },
  ],
  // Whether a notice is kept in history is its kind's lifetime (`NOTICE_LIFETIMES`), applied once
  // by `publishNotice` (and `noticeEntries`, for a writer that sends no event). A history entry
  // written by hand (`{ role: 'notice', ... }`) decides it at the call site again, which is how a
  // persistent kind could be streamed and never stored. Only that helper file is a `files:` exception in the
  // loop's eslint.config.js. It sees a plain, quoted-key, `as const` or `satisfies` literal role;
  // not covered: an entry built from a variable role, a computed key or a spread.
  'no-adhoc-notice-entry': [
    {
      selector:
        "ObjectExpression > Property:matches([key.name='role'], [key.value='role']):matches([value.value='notice'], [value.expression.value='notice'])",
      message:
        "Do not write a `{ role: 'notice' }` history entry by hand. `publishNotice` (`packages/loop/src/stream-agent/notice-publish.helper.ts`) sends the event and keeps the entry exactly when the kind's lifetime in `NOTICE_LIFETIMES` (`@sheavly/protocol/notice/notice.constants`) says persistent, so a call site never decides it. A new kind is its schema plus one registry entry. Restoring stored reports is the one other `files:` exception, in the loop's eslint.config.js.",
    },
  ],
  // What counts as the request in stored history is decided once, in `@sheavly/core`'s history
  // helpers: a stored `user` entry, never a notice, which only becomes a `user`-role message in
  // what a model is sent. A lookup of "the last user message" written by hand reads a model view
  // as if it were history, which is how a notice after the request once failed a summary. Code that
  // really works on a model's input (hooks, request logging) says so with a `files:` override.
  'no-adhoc-latest-request': [
    {
      selector:
        "CallExpression[callee.property.name=/^findLast(Index)?$/]:has(BinaryExpression[operator='==='][left.property.name='role'][right.value='user'])",
      message:
        "Do not look up the latest user message by hand with `findLast`/`findLastIndex`. For stored history use `latestRequest`, `latestRequestIndex` or `latestPromptIndex` (`@sheavly/core/history/history.utils`): a request is a stored `user` entry and a notice never is one. This rule recognises only that call shape; the same lookup written another way (a loop, `filter(...).at(-1)`) is not caught, so use the helpers anyway. Code that works on the messages a model is sent (a `beforeModelCall` hook's input, a request log) is a model view, where notices are `user` messages too: say so with a `files:` override and its reason in this workspace's eslint.config.js.",
    },
  ],
  // The main session is the one without a parent, defined once in `isMainSession`. A depth
  // comparison written by hand is a second definition that drifts when depth changes meaning.
  'no-adhoc-main-session': [
    {
      selector:
        "BinaryExpression[operator=/^[!=]==?$/]:matches([left.type='MemberExpression'][left.property.name='depth'][right.value=1], [right.type='MemberExpression'][right.property.name='depth'][left.value=1])",
      message:
        "Do not tell the main session by `depth === 1`. Use `isMainSession(session)` (`@sheavly/protocol/session/session.utils`): only a sub-agent has a parent. To know how the main run ended, use `runEnd(entry)` (`@sheavly/protocol/status/run-end.utils`) instead of matching `done` or `session_idle` entries yourself. Code that truly reads depth (a sub-agent's nesting cap) compares it with `MAX_SESSION_DEPTH`, not 1.",
    },
  ],
  // Instruction context reaches the history through `createInstructionHook`, which resolves the
  // working root each turn and owns the dedup. A hook that calls `appendInstructionContext`
  // itself is a fifth hand-rolled wrapper with its own idea of what it already sent. Only the
  // factory's file (a `files:` override in packages/core/eslint.config.js) imports the helper.
  'no-direct-instruction-context': [
    {
      selector: `:matches(ImportDeclaration, ImportExpression, ExportNamedDeclaration, ExportAllDeclaration)[source.value=${INSTRUCTION_CONTEXT_MODULE}]`,
      message:
        'Do not import or re-export `appendInstructionContext`. Add an instruction source: write `<name>Source(): InstructionSource` and build its hook with `createInstructionHook` (`@sheavly/core/instruction-context/instruction-source.helper`), registered with `registerInstructionHooks`. The factory resolves the working root per turn and owns the dedup, so a source keeps no state. See "An instruction source" in extending.md.',
    },
  ],
  // An instruction source reads files whose folder the agent can choose (a working root), so a
  // symlink there must not lead a foreign file or a `.env*` secret into the model's context. Such
  // reads go through `readConfinedFile` (`instruction-context/confined-read.helper.ts`), which
  // checks the real path and refuses to follow a swapped link. A file is an instruction source
  // when it imports the factory or its types, so the scope follows the code, not a list of files.
  'no-raw-fs-in-instruction-source': [
    {
      selector: `Program:has(ImportDeclaration[source.value=${INSTRUCTION_SOURCE_MODULE}]) :matches(ImportDeclaration, ImportExpression, ExportNamedDeclaration, ExportAllDeclaration)[source.value=${FS_MODULES}]`,
      message:
        "An instruction source does not read files with `node:fs`: its folder can be chosen by the agent, and a symlink there could lead a foreign file or a `.env*` secret into the model's context. Read through `readConfinedFile` (`@sheavly/workspace/instruction-context/confined-read.helper`), which checks the real path against the source's boundary and verifies the open file (a regular file, one name, under a size cap, the file the path names). The rule looks only at the source file's own imports: a source that reads through a sibling helper that uses `node:fs` is left to review. A source that reads only its own trusted folders says why in a `files:` override in the workspace's eslint.config.js.",
    },
  ],
  // A store that reads a file and writes it back whole changes it through `LockedChange`, which
  // adds the cross-process lock to the in-process queue. A bare `SerialQueue` orders only this
  // process, so a second process on the same folder would lose updates again.
  'no-raw-serial-queue': [
    {
      selector:
        "NewExpression[callee.name='SerialQueue'], NewExpression[callee.property.name='SerialQueue'], ImportSpecifier[imported.name='SerialQueue'][local.name!='SerialQueue']",
      message:
        'Do not queue a read-modify-write with a bare `SerialQueue`: it orders only this process, so two processes on one `~/.sheavly` lose updates. Change a file through `LockedChange` (`packages/storage/src/serial-queue/locked-change.service.ts`): a queue in the process and a lock file across processes. A queue that guards no file (the append-only logs, the profile queue that orders a check with a delete) is a `files:` override with its reason in packages/storage/eslint.config.js.',
    },
  ],
  // Model calls go out through `createModelFetch` (`packages/providers/src/http/model-fetch.helper.ts`),
  // whose TLS ClientHello fits in one TCP segment. Node's global fetch sends one that spans two on
  // Node 22.20+, 24.5+ and 26, and gateways that read one segment (Azure AI Foundry) reset it. So
  // the `fetch` an adapter registry is built with, written in the call, is `createModelFetch()`;
  // with no deps the registry uses it already. Tests and fakes pass their own. It reads the names
  // as written, called directly or as a member (`providers.createDefaultRegistry`), with `fetch` a
  // plain or quoted key. Not covered: deps held in a variable or spread in, a renamed import of
  // either name, a subclass's `super({ fetch })`, or a registry built another way; a renamed
  // `createModelFetch` is flagged, so import it by its name.
  'no-raw-model-fetch': [
    {
      selector:
        ":matches(CallExpression[callee.name='createDefaultRegistry'], CallExpression[callee.property.name='createDefaultRegistry'], NewExpression[callee.name='AdapterRegistry'], NewExpression[callee.property.name='AdapterRegistry']) > ObjectExpression > Property:matches([key.name='fetch'], [key.value='fetch']):not([value.type='CallExpression'][value.callee.name='createModelFetch'])",
      message:
        "Build an adapter registry with `fetch: createModelFetch()` (`@sheavly/providers/http/model-fetch.helper`), or with no deps at all, which uses it too. Node's global `fetch` sends a TLS ClientHello that spans two TCP segments on Node 22.20+, 24.5+ and 26, and gateways that read only one (Azure AI Foundry) reset the connection. A test or a fake passes its own `fetch`. See 'The model fetch' in packages/providers/docs/backends.md.",
    },
  ],
  // A protocol's reply is read by `readReply` (`http/reply-reader.helper.ts`), which owns the
  // event loop: unknown events skipped, cut-off versus abort, `done` only after a complete reply.
  // A protocol that imports the SSE reader itself is a fourth copy of that loop. Only the shared
  // reader's file (a `files:` override in the providers' eslint.config.js) imports it. Not
  // covered: a reader built on another way of reading the body (`response.body.getReader()`).
  'no-handrolled-reply-reader': [
    {
      selector: `:matches(ImportDeclaration, ImportExpression, ExportNamedDeclaration, ExportAllDeclaration)[source.value=${SSE_READER_MODULE}]`,
      message:
        'Do not read a reply\'s server-sent events yourself. Give `readReply` (`packages/providers/src/http/reply-reader.helper.ts`) the protocol\'s `parse`, `step` and `finish`: it owns the event loop, so unknown events, a cut-off stream, an abort and the final `done` behave the same in every protocol. See "Adding a backend" in packages/providers/docs/backends.md.',
    },
  ],
  // A model call goes out through `sendRequest` (`http/request.helper.ts`): its retries, its wait
  // for a lost connection (with the `model_connection` reports a provider streams), its response
  // timeout and its signing. A protocol that calls the injected `fetch` itself fails the run on
  // the first network error instead of waiting for the connection. Only the request helper (and
  // the connectivity probe, which sends a bare HEAD) call it: `files:` overrides in the
  // providers' eslint.config.js. Matches `fetch(…)`, `x.fetch(…)`, `x['fetch'](…)` and
  // `fetch.call/apply/bind(…)` (also on `x.fetch`). Not covered: a `fetch` passed on and called
  // elsewhere, or held in a variable under another name.
  'no-handrolled-model-send': [
    {
      selector:
        ":matches(CallExpression[callee.type='MemberExpression'][callee.property.name='fetch'], CallExpression[callee.name='fetch'], CallExpression[callee.computed=true][callee.property.value='fetch'], CallExpression[callee.property.name=/^(call|apply|bind)$/][callee.object.property.name='fetch'], CallExpression[callee.property.name=/^(call|apply|bind)$/][callee.object.name='fetch'])",
      message:
        'Do not call `fetch` for a model API yourself. `sendRequest` (`packages/providers/src/http/request.helper.ts`) is the one way a model call goes out: its retries, its wait for a lost connection (the `model_connection` reports a provider streams), its response timeout and its signing. Read it with `yield*` in the provider\'s `stream`. See "Sending a call" in packages/providers/docs/backends.md.',
    },
  ],
  // Three decisions every model protocol shares live in `packages/providers/src/http/`: how a body
  // is read (`readReply`), when and how long a call waits (`retry-policy.helper.ts`), and which
  // stored reasoning a request may carry (`ownReplay`). A protocol that reads the body with
  // `getReader()`, reads `retry-after` itself or compares a reasoning item's `source` rewrites one
  // of them. Enabled for the providers workspace, with `files:` overrides for the helpers that
  // own each. Not covered: a status compared as a number, a header read through a variable name.
  'no-handrolled-provider-policy': [
    {
      selector: "CallExpression[callee.property.name='getReader']",
      message:
        "Do not read a model reply's body with `getReader()`. Give `readReply` (`packages/providers/src/http/reply-reader.helper.ts`) the protocol's `parse`, `step` and `finish`.",
    },
    {
      selector: 'Literal[value=/^retry-after$/i]',
      message:
        'Do not read `retry-after` yourself. `retryAfterMs` and `backoffMs` (`packages/providers/src/http/retry-policy.helper.ts`) are the one retry policy: both header forms, jitter, and the longest wait.',
    },
    {
      selector: "BinaryExpression[operator=/^[!=]==?$/] > MemberExpression[property.name='source']",
      message:
        "Do not compare a reasoning item's `source` by hand. `ownReplay` (`packages/providers/src/http/replay.utils.ts`) is the one compatibility check, and it reports each item it leaves out.",
    },
  ],
  // "Timed out" for a command or a script is decided once, in `withDeadline`
  // (`packages/process/src/process/deadline.helper.ts`): the deadline aborted and the caller did
  // not. A timer of its own beside it is a second definition, which is how `ProcessRunner.run` and
  // `runScript` once disagreed about a cancel after the deadline. Enabled for the process folder
  // in the process package's eslint.config.js, with a `files:` override for the helper itself. Not
  // covered: a timer made another way (`timers/promises`, `AbortSignal.any` with your own signal).
  'no-adhoc-command-deadline': [
    {
      selector: "CallExpression[callee.object.name='AbortSignal'][callee.property.name='timeout']",
      message:
        'Do not set a command timeout with `AbortSignal.timeout` yourself. `withDeadline` (`packages/process/src/process/deadline.helper.ts`) is the one definition of "timed out" for a command or a script: the deadline aborted and the caller did not. Use its `signal` to stop the command and its `timedOut()` for the result.',
    },
    {
      selector: 'CallExpression[callee.name=/^(setTimeout|setInterval)$/]',
      message:
        'Do not run a timer for a command by hand. `withDeadline` (`packages/process/src/process/deadline.helper.ts`) is the one definition of "timed out" for a command or a script: use its `signal` to stop the command and its `timedOut()` for the result.',
    },
  ],
  // Ctrl+C in the terminal app is `interruptOnCtrlC`'s: the same-keypress window, one force-quit
  // policy that runs the cleanup before the process exits 130, and the stop that reports what it
  // found. A listener of its own is how four copies of that policy once drifted apart (a second
  // press that skipped cleanup, a window of 500 ms in one place and 1500 in another). Enabled for
  // the terminal app's source, with a `files:` override for the helper itself. Not covered: a
  // signal name held in a variable, or a key handled as raw input (the screen's `ctrl+c`).
  'no-adhoc-ctrl-c': [
    {
      selector:
        "CallExpression[callee.property.name=/^(on|once|addListener|prependListener)$/][arguments.0.value='SIGINT']",
      message:
        'Do not listen for SIGINT yourself. `interruptOnCtrlC` (`apps/terminal/src/interrupt/interrupt.helper.ts`) is the one Ctrl+C policy: a press within the same-keypress window is ignored, the first stops the work (`stop`), a press while it is stopping runs your `forceQuit` cleanup first and only then exits 130, and a press with nothing running calls `onIdle`. Pass `source` when readline owns the key. For work that is one `AbortController`, use `abortingStop`.',
    },
  ],
  // An approval that is no longer waiting (`unknown_approval`: answered elsewhere, or its call was
  // interrupted) is a normal end for a UI's answer, decided once in `answerWhileWaiting`. A UI that
  // matches the code itself is another copy of that rule, as the chat and the workbook's
  // `CheckApprovals` once were. Only the code that defines or produces the code is exempt, with a
  // `files:` override in its workspace's eslint.config.js. Not covered: the code read through a
  // variable or compared as another string.
  'no-adhoc-unknown-approval': [
    {
      selector:
        "Literal[value='unknown_approval'], TemplateLiteral[expressions.length=0] > TemplateElement[value.cooked='unknown_approval']",
      message:
        "Do not match `unknown_approval` yourself. Wrap the `answerApproval` call in `answerWhileWaiting` (`@sheavly/client/approvals/approvals.helper`): an approval that is no longer waiting (answered elsewhere, or its call interrupted) is a normal end for a UI's answer, and that is the one place that rule lives. The code that defines or produces the error code is a `files:` override with its reason in this workspace's eslint.config.js.",
    },
  ],
  // Per-chat hook state is read and written in one module, `chat-state.utils.mjs`: its schema, its
  // version, its lock and its expiry. A hook that finds the state folder itself (its env override
  // or its default path) writes files none of that guards. Enabled for `.cursor/hooks` in the
  // root eslint.config.js, with the module itself and the tests exempt. A string or template piece
  // holding either name fails, whole or inside a longer path. Not covered: a name split across
  // pieces, or a state folder read through a variable.
  'no-adhoc-chat-state': [
    {
      selector:
        ":matches(Literal[value=/SHEAVLY_HOOK_STATE_DIR|sheavly-harness/], TemplateElement[value.cooked=/SHEAVLY_HOOK_STATE_DIR|sheavly-harness/], Identifier[name='SHEAVLY_HOOK_STATE_DIR'])",
      message:
        "Do not locate the hooks' chat state yourself. `chat-state.utils.mjs` is its only reader and writer (`getChatState`, `updateChatState`, `changeChatState`, `keepShownInChat`): a schema for every field, a version, a lock, an atomic write and expiry. A new field is a line in its `SCHEMA`; a read-modify-write of one field is a `changeChatState`.",
    },
  ],
  // Text is split into lines at `\n` and `\r` only. A multiline regex (`m`) also breaks at U+2028
  // and U+2029, which JSON.stringify leaves unescaped inside a string: `.` and `$` stop at one, so
  // a value is cut short (an SSE frame's data was, and its stream was lost), and `^` matches after
  // one, so a label inside a value passes for a line of its own. Applies to workspace source, not
  // tests. Matches a regex literal with the flag or the `(?m:…)` modifier, and `RegExp(…)` /
  // `new RegExp(…)` (also as a member, `globalThis.RegExp`) whose flags are a string or a template
  // literal with `m`. Not covered: flags held in a variable, a pattern without the flag that
  // still uses `.` or `$` on text with separators in it (`/^x(.*)$/` finds nothing past one), and
  // plain-JS files outside `src/**/*.ts`, which review carries.
  'no-multiline-regex': [
    {
      selector:
        ":matches(Literal[regex.flags=/m/], Literal[regex.pattern=/\\(\\?[ims]*m[ims]*(-[ims]*)?:/], :matches(NewExpression, CallExpression):matches([callee.name='RegExp'], [callee.property.name='RegExp']):matches([arguments.1.value=/m/], [arguments.1.quasis.0.value.cooked=/m/]))",
      message:
        "Do not match lines with the `m` flag: its `^`, `$` and `.` also break at U+2028 and U+2029, which JSON leaves unescaped in a string, so a value is cut short, or a label inside a value is taken for a line of its own. Without it, a line starts where nothing but `\\r` or `\\n` comes before (`(?<![^\\r\\n])`) and ends before one (`(?![^\\r\\n])`), and its text is `[^\\r\\n]*`; or split on `\\n` alone, as `fieldOf` does in `packages/client/src/client/entries.helper.ts`. Text whose line structure is only ever yours is a `files:` override with its reason in this workspace's eslint.config.js.",
    },
  ],
  // `relative.startsWith('..')` also matches a folder named `..x/`, so an "is inside" check built
  // on it lets that folder count as outside (or refuses it as inside).
  'no-dotdot-prefix': [
    {
      selector: "CallExpression[callee.property.name='startsWith'][arguments.0.value='..']",
      message:
        "`startsWith('..')` also matches a folder named `..x/`. To test whether a path is inside a folder use `isInside` (`@sheavly/workspace`'s `workspace/workspace.utils`); elsewhere, compare `relative === '..' || relative.startsWith(`..${path.sep}`)`.",
    },
  ],
};

/** A rule that reports every node matching one of `entries`' selectors with its message. */
export function syntaxRule(entries) {
  return {
    meta: {
      type: 'suggestion',
      schema: [],
      messages: Object.fromEntries(entries.map(({ message }, index) => [`m${index}`, message])),
    },
    create(context) {
      return Object.fromEntries(
        entries.map(({ selector }, index) => [
          selector,
          (node) => context.report({ node, messageId: `m${index}` }),
        ]),
      );
    },
  };
}
