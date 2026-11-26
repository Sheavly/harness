# Where each current entry goes

The wire model ([wire-model.md](wire-model.md)) replaces the combined stream. This page maps every
entry the stream carries today, from the schemas in `packages/protocol/src`, to a channel and an
entry type, so that none is left without a place. It is part of the decision, and the schemas of
#422 follow it.

Channels: **agent** is an agent node's own channel (the main agent's or a sub-agent's), **tree**
is the conversation's tree channel, **command** is a command or service node's channel. A
**phase 1** entry keeps today's content and is only wrapped in the new envelope; the item model of
phase 2 (#434) changes how some are shaped, and is not repeated here.

## What a `StreamEntry` field becomes

| Today                  | In the model                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq` (one per tree)   | The channel's cursor, per channel                                                                                                                                            |
| `sessionId`            | The channel: a session's entries are its node's channel                                                                                                                      |
| `messageId`            | Kept on agent-channel entries: the originating user message                                                                                                                  |
| `at`                   | `at`                                                                                                                                                                         |
| `kind`: `event`        | An agent-channel `event` entry wrapping the event, or `event_omitted` when it is too large to store; adjacent `text_delta` events of a session are merged into one entry     |
| `kind`: `update`       | The tree channel (a node's lifecycle) and the node's own `opened` and `closed`                                                                                               |
| `kind`: `approval`     | The tree channel                                                                                                                                                             |
| `kind`: `task`         | The tree channel, and the command or service channel's `opened` and `closed`                                                                                                 |
| `kind`: `queue`        | The tree channel, as the conversation's own notices                                                                                                                          |
| `session` filter       | A subscription to that node's channel                                                                                                                                        |
| `subtree` filter       | A subscription to each channel of the subtree, found from the tree channel                                                                                                   |
| `approvals` filter     | The request's `approvals` flag, kept: it says this client answers approvals. A subscription to the tree channel alone does not, as a read-only sidebar also subscribes to it |
| `replay`               | `from: start`                                                                                                                                                                |
| `Last-Event-ID` resume | The client's last cursor for each channel, sent again in the request body                                                                                                    |

## Loop events (`AgentEvent`, 24)

All stay on the agent channel of the session that produced them, in phase 1, unless the row says
otherwise. A row marked "live" is stored in phase 1 like every entry (the entry log keeps all of
them today) and becomes live only, outside the durable log, in the item model (#434).

| Event                 | Where and how                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_failed`          | Agent channel. The node's state on the tree channel follows: a sub-agent closes as `failed`, the main agent returns to `idle`                                                                                                                                                                                                               |
| `usage`               | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `harness_notice`      | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `text_delta`          | Agent channel, live: a delta of an assistant item (phase 2 shapes it, as `started`/`delta`/`completed`)                                                                                                                                                                                                                                     |
| `reasoning`           | Agent channel: opaque state, kept for replay                                                                                                                                                                                                                                                                                                |
| `model_connection`    | Agent channel, live                                                                                                                                                                                                                                                                                                                         |
| `reasoning_activity`  | Agent channel, live                                                                                                                                                                                                                                                                                                                         |
| `tool_call_started`   | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `turn_end`            | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `tool_batch`          | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `tool_result`         | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `task_running`        | Agent channel, in place of `tool_result` for a call that launched a node. It carries the child's node id as `nodeId` (the child does not exist when `tool_call_started` is sent), next to a `TaskInfo` whose `id` is only a counter and whose `agentSessionId` names the session a sub-agent runs. The new node appears on the tree channel |
| `task_completed`      | Agent channel of the session that started the node: what the model is told at the next turn. The node's own end is the tree channel's and its channel's `closed`                                                                                                                                                                            |
| `message_received`    | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `run_state`           | Agent channel, live. It is finer than the node's `running`/`idle`: `waiting` with its count of grouped tasks stays here                                                                                                                                                                                                                     |
| `context_added`       | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `model_input_changed` | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `summary_started`     | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `summary_done`        | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `summary_failed`      | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `hook_failed`         | Agent channel                                                                                                                                                                                                                                                                                                                               |
| `storage_failed`      | Tree channel, as a conversation notice: it is about the conversation, not a node, and today the event's own `seq` is 0, outside any run                                                                                                                                                                                                     |
| `extension_event`     | Tree channel, as a conversation notice, as today (outside any run, with the event's own `seq` 0). An extension's own node kind puts its entries on that node's channel instead (#433)                                                                                                                                                       |
| `done`                | Agent channel: the run's end and how it ended. On the tree channel the node goes `idle` (main agent) or closes with that outcome (sub-agent)                                                                                                                                                                                                |

## Session updates (`SessionUpdate`, 8)

A session is a node. These become the node's lifecycle, which the tree channel carries and the
node's own channel opens and closes with.

| Update             | Where and how                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `session_started`  | Tree channel: a node opened (kind `agent`, with its parent and the spawning tool call). Its channel's `opened` |
| `session_status`   | Tree channel: the node's status text (`report_status`) changed                                                 |
| `session_message`  | Agent channel of the receiving session: a message queued in its inbox. `message_received` is its delivery      |
| `session_idle`     | Tree channel: state `idle`                                                                                     |
| `session_resumed`  | Tree channel: state `running`                                                                                  |
| `session_model`    | Tree channel: the node's model and effort changed. A sidebar reads the model there                             |
| `session_ended`    | Tree channel: a terminal state, with how the last run ended. The channel's `closed`                            |
| `session_released` | No wire entry, and extensions are told of it through the host's scope: see "Decisions this leaves" below       |

## Task updates (`TaskUpdate`, 2)

A task is a node, and a sub-agent is the same node as its session, so the join through the tool
call id goes away.

| Update         | Where and how                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `task_started` | Tree channel: a node opened (kind `command` or `service`; a task of kind `agent` is the `session_started` node). The channel's `opened` |
| `task_ended`   | Tree channel: a terminal state, with the exit code and the bounded output preview. The channel's `closed`                               |

## Approval updates (`ApprovalUpdate`, 3)

All on the tree channel, each with the id of the node that asked (`sessionId` today), so one
subscription tells a front end that anything waits for the user.

| Update               | Where and how                  |
| -------------------- | ------------------------------ |
| `approval_requested` | Tree channel, with the node id |
| `approval_resolved`  | Tree channel                   |
| `approval_cancelled` | Tree channel                   |

## Queue updates (`QueueUpdate`, 3)

The queue belongs to the conversation, not to a node, so all three are conversation notices on the
tree channel.

| Update           | Where and how                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `queue_changed`  | Tree channel                                                                                  |
| `prompt_started` | Tree channel. See "Decisions this leaves": its ordering before the run's entries needs a link |
| `prompt_refused` | Tree channel                                                                                  |

## Decisions this leaves

Mapping every entry shows three places where today's behaviour does not carry over by itself. The
first is for #423, the second for #422, the third for the release of the protocol.

1. **`session_released`.** The registry forgets a sub-agent's ended session once its report was
   delivered. Nodes need no wire entry for that: a closed node stays in the tree channel's
   snapshot, with its channel and its report, until the conversation closes, and a front end
   decides what to show. Two things react to the event today. The host's `session-info`
   service forwards it to extensions as part of `SessionLifecycleUpdate` (`onLifecycle`), and
   coding's file reads are one such listener: they call `forgetAgent` on it. The terminal's
   renderer handles the event and draws nothing, since the ended card is already in the
   scrollback, so it needs no replacement. `onLifecycle` is an extension-facing API, and an
   extension cannot hold a registry (#102), so it keeps delivering a release to extensions, with
   the node registry's release as its source and the host's scope as the way it reaches them.
   Whether the registry may still forget the live object, and what the scope sends when it does,
   is #423's and #424's.
2. **`prompt_started` before the run's entries.** Today the stream's one order guarantees that
   `prompt_started` comes before the entries of the run it starts. Per-channel cursors do not
   order across channels. The link that carries it is the message id: `prompt_started` names the
   user message, and the run's agent-channel entries already carry `messageId`. `prompt_started`
   held only the line's `text`, so the tree channel's entry of that type carries the message id
   too (`TreeChannelEntry`), and a prompt that started returns it in its answer.
3. **A stream that still parses.** A stored stream written in the old layout does not parse
   under the new schemas. Conversations are migrated when first opened (#437), and the protocol
   change is wire-breaking, as the contract's "Version" says.
