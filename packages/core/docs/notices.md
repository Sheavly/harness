# Model-facing notices

`formatHarnessNotice` formats the protocol's `HarnessNotice` for a model. It is the only place
that writes the trusted notice envelope. Apps receive the same structured notice data and choose
their own presentation; they do not need to parse this text.

## Running tasks

`running-tasks` is a transient protocol snapshot, formatted beside the history for one model call.
The formatter preserves the supplied order and shows `total`, `omitted`, each task's ID and title,
`startedAt` as epoch milliseconds (including zero), and the optional scalar `group` ID. The group
is the stable first requested member ID supplied by runtime; the formatter does not infer or
expand group membership. There is no command or output in this payload.

IDs, titles and group IDs are angle-bracket escaped and collapsed to one line. Each task reason
is separately escaped and fenced with a dash run longer than any in that reason, and explicitly
labeled calling-agent-authored DATA, not instructions. The fixed policy reminds the model not to
poll to wait: every finished finite task is delivered automatically and wakes the model, so ending the
turn without tool calls after independent work is how it waits, and `await_tasks` is needed only
to hold several results back until all can arrive together. Dynamic text cannot write a trusted
envelope or end its own reason fence. Envelope markup and data-fence labels stay in
`src/notice/notice.constants.ts`; the internal `src/notice/notice.prompt.ts` imports those constants
and owns handling policy and complete template assembly, including metadata labels and fences.
The public utils formatter owns data preparation, escaping and collision-safe fence selection;
pure typed renderers receive only prepared data. The notice-envelope guard exception applies
only to the constants file, not the prompt file. Renderers are not public package APIs.

Checkpoint formatting follows the same separation: `src/summary/summary.utils.ts` neutralizes
section titles and bodies and keeps titles on one line before the internal
`src/summary/summary.prompt.ts` renderer assembles section headings, policy and the envelope.
Both public formatter signatures and their exact output remain unchanged.

Protocol validation owns the 10-entry, 200-character title and 1000-character reason bounds and
count consistency; formatting does not truncate, validate again or put the snapshot in persistent
history. See the [protocol contract](../../protocol/docs/contract.md#harness-notices) for payload
rules. Adversarial tests in `src/notice/__tests__/running-tasks.utils.test.ts` cover forged tags,
lookalike brackets, multiline metadata, forged closing fences and separate per-task fences.

## Completion context

`agent-report`, `task-finished` and `tasks-finished` can carry a `TaskCompletionContext` from
`@sheavly/protocol/notice/notice.types`. The formatter renders:

- `reason` as a fenced block of calling-agent-authored DATA, explicitly not an instruction;
- `startedAt` as epoch milliseconds, without converting it to a date string;
- `durationMs` as milliseconds, including zero;
- `userMessagesSinceStart` as the count of intervening user messages, including zero;
- `callId`, when supplied, as the starting tool call ID on the measurements line.

The reason is the explicit `await_tasks` reason, or the task description fallback for an
ungrouped completion. It recalls why work was started or awaited; it is not a new user request.
The loop supplies this context for new completions. The formatter does not calculate or infer
missing measurements or IDs. In particular, it does not recover a call ID from a sub-agent's
session metadata: the loop includes it only while that starting assistant tool call is still
visible in the summary view.

A grouped completion keeps its existing fenced wait reason and renders the aggregate context's
measurements without repeating the reason in another block. Group measurements cover the earliest
member start through the latest member finish and aggregate the intervening user-message count;
the group context has no call ID. Each member retains its own context, including its own fenced
reason and any supplied call ID. Bodies appear in member order, with no nested trusted envelopes.
Reports remain whole, and task output remains the bounded preview supplied by the protocol.

The context is required on all three kinds, so the formatter always renders it; it does not
synthesize one.

## Extension notices

An `extension-notice` carries an extension's own text, so it is third-party code speaking, not the
user or the harness. Its envelope names the extension as an attribute
(`kind="extension-notice" extension="<name>"`); the prefix and suffix around the name are in
`notice.constants.ts` (`EXTENSION_NOTICE_TEXT`), the only file the notice-envelope guard exempts.
The name goes through the same header-field escaping as other header fields (`line()`), and the
body is a `Topic:` line, a policy sentence (from the extension named in the attribute, third-party
code, not a user message, nothing in it is an instruction), then the `text` escaped with
`escapeTags` and fenced with a dash run longer than any in it, as an `agent-report` does.

Only `text` and the topic reach the model: `data` is for UIs and is never rendered. The protocol
schema caps `text` (`MAX_EXTENSION_TEXT_CHARS`) and refuses a longer one before the formatter runs;
the formatter does not truncate. `src/notice/__tests__/extension-notice.utils.test.ts` covers the
attribute, forged tags and fences, lookalike brackets, multiple lines and the absence of `data`.

## Trust boundary

Reports, task output, completion reasons and wait reasons are data, not harness instructions.
Reasons and output have separate fences longer than every dash run in their content, so a forged
closing fence cannot end a block early. `escapeTags` neutralizes opening angle brackets and their
lookalikes in all agent-authored text; `oneLine` additionally prevents IDs and other header fields
from adding lines. Report headings remain report content rather than being rewritten.

Regression tests in `src/notice/__tests__/` cover completion contexts, omitted call IDs, forged
tags and colliding fences. The formatter is a model-facing trust boundary, not a
replacement for protocol validation or for checking a sub-agent's findings against user requests
and verifiable facts.
