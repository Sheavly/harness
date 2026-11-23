# Approvals

How a tool asks the user to approve something, and how a UI answers. `run_command` is the tool that asks ([@sheavly/coding](../../../extensions/coding/docs/run-command.md)).

## One state machine

Every approval is in one state of `APPROVAL_TABLE` (`approvals.constants.ts`), held by the
registry (`state(id)`), and reaches a terminal state once:

| State       | Meaning                                                                 | May move to                  |
| ----------- | ----------------------------------------------------------------------- | ---------------------------- |
| `requested` | waiting for an answer                                                   | answered, cancelled, expired |
| `answered`  | `respond`, or a screener's answer                                       | final                        |
| `cancelled` | its call was interrupted, or its session ended (`cancelSession`)        | final                        |
| `expired`   | failed closed: nobody was listening, or a listener threw on the request | final                        |

A refused move changes nothing: `respond` for an id that is not `requested` throws `unknown_id`
and names its state, so a UI that answers late can tell "someone answered first" from "never
existed" in the message. `createHarness` calls `cancelSession` when a session ends, while its
approvals are still kept under it, and the session registry forgets the approval-to-session map of
a released session. A request that expired is announced as `approval_cancelled` too, so a listener
that heard it asked does not keep showing it. Settled states are kept for `SETTLED_KEPT`
approvals, oldest forgotten first.

**An id is unique** in its conversation for as long as the server keeps it, reopening included, so
an answer can only mean the approval it was made for: it is `a-` and a random UUID, never a counter
that starts again, and a registry made later refuses an id it never issued as `unknown_id`, with
the request still waiting. A test that wants to name its requests uses `numberedApprovals()`
(`@sheavly/runtime/testing/approvals.fake`), which numbers them `a1`, `a2`. At most
`MAX_PENDING_APPROVALS` (1000) wait at once, the bound of the tree's snapshot: a request past it
fails closed as `too_many_pending`, the way one nobody can hear does, and another is taken as soon
as one is answered or given up.

## The harness asks, the UI renders

The harness renders no prompt. A command that needs approval waits in an `ApprovalRegistry`
(`@sheavly/runtime/approvals/`; `createHarness` makes one, as `harness.approvals`, unless one is passed in), which emits typed
`ApprovalUpdate` events to its subscribers. The UI subscribes, shows each request its own way,
and answers with `respond`:

```ts
harness.approvals.subscribe((update) => {
  if (update.type === 'approval_requested') ui.show(update.request);
});
harness.approvals.respond({ id: request.id, response: { decision: 'approve' } });
```

| Update               | Carries                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| `approval_requested` | `request`: `id`, `callId`, `sessionId`, `tool`, `command`, `concerns`, `options`    |
| `approval_resolved`  | `id` and the `response`, once it's answered                                         |
| `approval_cancelled` | `id`: the waiting call was interrupted (its `signal` aborted) before an answer came |

`concerns` is `{ argument, reason }[]`; `options` defaults to
`['approve', 'skip', 'skip_with_message']`, or the caller supplies the offered options.
When offering `always_allow`, a caller can supply `keeps`, the exact allow-list entries the
choice would save. The registry carries these in both the request update and `pending()`, so
a UI can show what the user is agreeing to. The caller owns saving the entries.
The tool waits (the run's other tools and the model stream carry on) until `respond` is called
with one of:

- `{ decision: 'approve' }`: the command runs as asked.
- `{ decision: 'always_allow' }`, if offered: the caller saves the entries and runs the command.
- `{ decision: 'skip' }`: the command doesn't run; the model gets an error result naming the
  arguments.
- `{ decision: 'skip_with_message', message }`: the command doesn't run, and the message is added
  to that result ("Instead, the user says: …"), so it steers the model's next step.

`respond` validates the answer with zod and throws for a malformed one, a decision not offered,
or an id that isn't waiting (an `ApprovalRequestError`); `pending()` lists open requests for a UI
that connects late.
With no subscriber (a headless run, the demo, the workbook) those commands are refused right away
instead of waiting. A refused or skipped command fails the tool call with a `CommandRefusedError`
(`reason: 'needs_approval' | 'skipped'`), whose message is what the model reads.

`observe` hears every update too, first, but doesn't count as someone who can answer: with only
observers, a request is still refused. `createHarness` observes its registry to put each update
in the sessions' combined stream (`kind: 'approval'`, under the session whose tool asked, the
main session for a call outside the loop), so a UI following the stream sees approvals in order
with the events of the call that asked, and a replay shows which still wait.

A subscriber that throws doesn't stop the others: every listener still hears the update, then an
`ApprovalListenerError` reaches whoever caused it. On `approval_requested` the request fails
closed (the command doesn't run), unless a listener already answered it while hearing the
update, which stands; on `approval_resolved` the call still gets its answer and `respond`
throws; on `approval_cancelled` the call fails with that error.

These updates come from the registry, not the loop's event stream: a tool result waiting in that
ordered stream would hold back the request it waits for.
