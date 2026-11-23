# Design

How this workspace works inside, why it is built this way, and how to extend it.

## One entry, made safe once

`createLogger` turns each call into one `LogEntry` with `createLogEntry` and hands that same
frozen entry to every sink. Redaction happens there and nowhere else, so a sink never has to
remember to do it:

- A `text` field must be a string (anything else is dropped, named in `droppedFields`, never
  written as it came). It is cut to 512 characters and goes through `redactDiagnosticText`
  (`@sheavly/core`, credentials in their usual forms), then loses e-mail addresses and JWTs. A
  `count` must be a finite number. A digit run is left alone there: an id can be all digits.
- An `error` field becomes an `ErrorRecord`: `errorDetails` (`@sheavly/runtime`) gives the name,
  code, bounded stack and cause chain, the message is added (cut to 8,192 characters), and every
  string in it also loses long digit runs (a personal identity number, a phone number). Details
  that were already captured are redacted the same way, to a bounded depth.
- No pattern runs on an unbounded string: every string is cut to 16,384 characters first, and the
  e-mail pattern's parts are bounded, so a long run of address characters cannot make it slow.
- Redaction is pattern matching, not a guarantee: a secret in a form no pattern knows passes. The
  field list is what keeps free text out in the first place.

## The closed field list

`LOG_FIELD` is the only place a field exists, and `LogFields` is derived from it, so a key that
is not there does not compile (the tests pin this with `@ts-expect-error`). At runtime the entry
drops the key and names it in `droppedFields`. A new field is a reviewed decision: what does it
answer when someone debugs, and can its value hold personal data? Never a body, a prompt or free
text.

## Sinks

A sink is a function from an entry to nothing or a promise: a file, the terminal, a test. The
logger holds no state about them and reads no env, so a package that must not do terminal I/O can
still log. A sink that throws or rejects is told to `onSinkFailure` (its position and what it
threw) and the others still get the entry; the caller is never told. An entry that cannot be made
is reported the same way, with a position of `-1`, and nothing is written. `onSinkFailure` itself
must not throw: nothing is left to tell, so a reporter that can fail must guard itself. An async
sink is not awaited, so a slow disk never slows a request. The logger does not order entries
across an async sink's writes: a sink that writes a file keeps its own order (the storage
sinks do).

## Events

An event name is a constant of the calling module (`LOG_EVENT` and `LOG_EVENT_MEANING` in its
constants file), a lowercase dotted `<area>.<what_happened>`. This package has none: it never logs
about itself. The `harness/*` logging rules and the catalogue suite check the names; the guide is
`.agents/skills/sheavly/logging.md`.
