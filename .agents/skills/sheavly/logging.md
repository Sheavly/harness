# Logging

How the harness records a failure so it can be traced later. `@sheavly/logger` is the one
mechanism: the backend logs where an error ends, once, into the conversation's `log.jsonl` (or the
server's `~/.sheavly/logs/backend.jsonl` when there is no conversation), and stderr is one more
sink. Where the files are and how to read them with `jq` is [debugging.md](debugging.md).

## When to log

An error is logged **where it ends**: the place that catches it and does not throw it on. In the
backend that is the API's `onError`, a prompt that fails while it drains in the background, a run
the conversation starts by itself, an extension problem. Every place above that only rethrows,
adding `cause` if it adds a message.

- A `catch` that logs **and** rethrows reports one fault twice (`harness/no-log-and-throw`).
- A failure the caller is told about (a typed error the client gets as `not_found`) is not logged:
  the client has it. Log what the client is NOT told (`internal`) or what has no caller.
- A package never logs to the terminal: it takes a sink or returns the error. The app wires sinks.
- No new `console.*` or `process.stderr.write` for a failure in an app that has the logger
  (`harness/no-failure-output-in-catch`): stderr is already one of its sinks.

## Levels

| Level   | For                                                                      |
| ------- | ------------------------------------------------------------------------ |
| `error` | something failed and the work did not happen (a request, a run, a write) |
| `warn`  | something failed and the work went on without it (an extension, a prune) |
| `info`  | a lifecycle fact worth keeping (not used yet: only failures are logged)  |
| `debug` | detail for a person who asked for it; never on by default                |

The logger's minimum level is `info` unless the app sets one.

## The error is a value

Pass the caught value as `error` and nothing else about it:

```ts
logger.error(LOG_EVENT.PROMPT_FAILED, { error: caughtError });
```

The logger serializes it with its stack and cause chain (`errorDetails`, `@sheavly/runtime`) and
redacts it. `error.message`, a template or `String(error)` keeps one line of text and throws away
what traces the failure (`harness/log-error-as-value`).

## Event names

An event is a member of the calling module's `LOG_EVENT`, in its constants file, with a sentence in
`LOG_EVENT_MEANING` (what happened, and which fields it carries). The value is a lowercase dotted
`<area>.<what_happened>`: `api.request_failed`, `conversation.wake_run_failed`. A string or a
template at the call is an event no catalogue knows (`harness/log-event-name`). Add the event
where it is used, not in a shared list.

A derived suite (`packages/eslint-config/src/__tests__/log-events.test.js`) reads every
workspace's catalogue: no value used twice, a well-formed name, a meaning of at least a sentence
for each event, and no event that nothing uses. A workspace that starts logging is covered by
exporting `LOG_EVENT`; nothing is listed.

## A log field

`LOG_FIELD` (`packages/logger/src/logger/logger.constants.ts`) is the closed list of keys a call
may pass; a key outside it does not compile and is dropped at runtime, named in `droppedFields`.
It holds ids, codes, counts and names of things: `conversationId`, `sessionId`, `route`,
`status`, `error`. **Never** a request body, a prompt, a tool input, a row or a person's text.

Adding a field is a reviewed decision, not an edit made while logging:

1. What does it answer when someone debugs a conversation? If nothing, do not add it.
2. Can its values hold personal data or a secret? Then it is not a field.
3. Add the key to `LOG_FIELD` with its kind (`text`, `count`, `error` or `details`), and say why in
   the PR. A test pins the exact list (`logger.utils.test.ts`), so an addition is a visible diff.

## What the logger does for you, and what it does not

- Every string in an entry is redacted once, in `createLogEntry`, before any sink sees it:
  credentials in their usual forms (`redactDiagnosticText`), e-mail addresses and JWTs in every
  string, and long digit runs in an error's text (not in an id, which can be all digits). A `text`
  field must be a string and is cut to 512 characters; a `count` must be a finite number; anything
  else is dropped and named in `droppedFields`. No pattern runs on an unbounded string. This is
  pattern matching, not a guarantee: a secret in a form no pattern knows passes, so the field list
  is what keeps free text out.
- A sink that throws or rejects never breaks the caller or the other sinks; it is told to
  `onSinkFailure`, which the backend writes to stderr, and so is an entry that could not be made
  (position `-1`). `onSinkFailure` itself must not throw. Entries are written in the background,
  so a request never waits for the disk; a file sink keeps the order it was given
  (`OrderedAppends`).
- The logger reads no env and does no terminal I/O. The app builds the sinks (`createBackendLogs`)
  and the stores own the files (`FileConversationStore.logSink`, `serverLogSink`).

## Pure files do not log

A `*.utils.ts`, `*.validator.ts` or `*.prompt.ts` returns a value and does nothing else, so it
neither builds a logger nor calls one (`harness/no-logger-in-pure-kind`). It returns what the
caller should log, and a helper or service logs it.

## What lint cannot decide

- Whether a failure is logged **where it ends**: a rule sees a catch that logs and throws, not
  an error logged one frame too high or never.
- A logger held under a name that does not read as one (`audit`, `sink`) is not recognised as a
  logger by the rules, which read the receiver's name (`logger`, `log`, `logs`, `*Logger`).
- A stack of `try`/`catch` split across functions, or `return Promise.reject(error)` after a log.
- An `error` built by a helper the rule does not name, a logger reached through an alias
  (`const l = logger`) or fields passed as a variable, and error text in another key
  (`code: e.message`): only the `error` key and the helpers named in the rule are read.
- Whether a field's value is private. The list is closed and reviewed; the values are not read.
- Output written through a function an app passes around (`log(text)`) rather than `console` or
  `process.stderr`.

## Adding logging to a new place

1. Find where the error ends. If it ends in a caller, throw instead.
2. Add the event and its meaning to the module's constants file.
3. Log with the caught value: `logger.error(LOG_EVENT.X, { error: caughtError })`, from a logger
   built for the conversation (`logs.conversation(id)`) or the server (`logs.server`).
4. A test reads the entry the way a person would: through a collecting sink, or the real file.
