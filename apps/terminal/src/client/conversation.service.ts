import { watchTreeApprovals } from '@sheavly/client/approvals/watch-tree-approvals.helper';
import { createClient } from '@sheavly/client/client/client.helper';
import { followConversation } from '@sheavly/client/client/follow.helper';
import { RefusedError } from '@sheavly/client/errors/client.errors';
import { promptEntries } from '@sheavly/client/prompt/prompt.helper';
import { watchTree } from '@sheavly/client/tree/watch-tree.helper';
import type { ApprovalId, ApprovalResponse } from '@sheavly/protocol/approval/approval.types';
import type { ClientHistoryMessage, HistoryMessage } from '@sheavly/protocol/history/history.types';
import type { ModelEffort, ModelId } from '@sheavly/protocol/model/model.types';
import type { PromptSent } from '@sheavly/protocol/node-command/node-command.types';
import type { ProfileId } from '@sheavly/protocol/profile/profile.types';
import type { ConversationDetails, ConversationId } from '@sheavly/protocol/server/server.types';
import { isMainSession } from '@sheavly/protocol/session/session.utils';
import { runEnd } from '@sheavly/protocol/status/run-end.utils';
import type { SkillInfo } from '@sheavly/protocol/skill/skill.types';
import type { StreamEntry } from '@sheavly/protocol/stream/stream.types';
import type { TreeView } from '@sheavly/protocol/tree/tree.types';
import { emptyTree } from '@sheavly/protocol/tree/tree.utils';
import { backgroundOf, sameBackground } from './background.utils.js';
import type { AskedApproval, Backend, Background } from './client.types.js';
import { BackendError } from '../errors/backend.errors.js';

type Client = ReturnType<typeof createClient>;

function clientFor(backend: Backend): Client {
  return createClient({
    url: backend.url,
    token: backend.token,
    ...(backend.fetch && { fetch: backend.fetch }),
    ...(backend.reconnect && { reconnect: backend.reconnect }),
  });
}

/**
 * One conversation on a backend, as the terminal drives it: started (or continued from saved
 * `messages`) on `open`, then prompts sent and their entries read, over HTTP only, through the
 * client built from the API's routes. The background work still running is read from the
 * conversation's tree once `watchBackground` follows it, for the status line to show. A refused
 * request throws `RefusedError`.
 */
export class RemoteConversation {
  readonly #client: Client;
  /** The tree as `watchBackground` last saw it: empty until it follows it. */
  #tree: TreeView = emptyTree();

  private constructor(
    client: Client,
    readonly id: ConversationId,
  ) {
    this.#client = client;
  }

  /** Starts a conversation on `backend`, empty or continuing `messages`. */
  static async open(params: {
    backend: Backend;
    messages?: ClientHistoryMessage[];
    workspace?: string;
    /** The model to start on, by id or name; the profile's own choice when omitted. */
    model?: string | undefined;
    /** The reasoning effort to start on, for this conversation only; the profile's own when omitted. */
    effort?: ModelEffort | undefined;
    /** The profile to start on; the workspace's binding, else the default, when omitted. */
    profile?: ProfileId | undefined;
  }): Promise<RemoteConversation> {
    const { backend, messages, workspace, model, effort, profile } = params;
    const client = clientFor(backend);
    const { id } = await client.call('startConversation', {
      body: {
        ...(messages && { messages }),
        ...(workspace && { workspace }),
        ...(model && { model }),
        ...(effort && { effort }),
        ...(profile && { profile }),
      },
    });

    return new RemoteConversation(client, id);
  }

  /** Reopens a saved conversation under its original id, history, workspace and model selection. */
  static async reopen(params: {
    backend: Backend;
    id: ConversationId;
  }): Promise<RemoteConversation> {
    const client = clientFor(params.backend);
    const { id } = await client.call('reopenConversation', { id: params.id });

    return new RemoteConversation(client, id);
  }

  /** How many background nodes the tree says still run: commands, sub-agents and services. */
  get runningTasks(): number {
    const { tasks, agents, services } = this.background;

    return tasks + agents + services;
  }

  /**
   * The background work the tree says still runs: sub-agents, services, and everything else (a
   * command). None until `watchBackground` has followed the tree.
   */
  get background(): Background {
    return backgroundOf(this.#tree);
  }

  /**
   * Follows the conversation's tree and tells `listener` the background work whenever it changes
   * (not when only something else in the tree does). The tree is the one source: a node that is
   * running and has a parent is work in the background of the main agent, and it is counted from
   * its opening to its end, however the prompt that started it was sent, with nothing to
   * deduplicate between streams. Resolves once the backend accepted the connection, which is when
   * the counts start to be true; `ended` resolves when `signal` aborts and rejects when the tree
   * can no longer be followed (a conversation that was closed, a refusal, a stream that was lost).
   */
  async watchBackground(params: {
    listener: (background: Background) => void;
    signal: AbortSignal;
  }): Promise<{ ended: Promise<void> }> {
    const { listener, signal } = params;
    let told = this.background;
    const watch = await watchTree({
      client: this.#client,
      id: this.id,
      signal,
      onChange: (tree) => {
        this.#tree = tree;

        const now = this.background;

        if (sameBackground({ a: now, b: told })) return;

        told = now;
        listener(now);
      },
    });

    return { ended: watch.ended };
  }

  details(): Promise<ConversationDetails> {
    return this.#client.call('getConversation', { id: this.id });
  }

  /** The skills a prompt can run, all or those `search` matches (name or description). */
  async skills(search?: string): Promise<SkillInfo[]> {
    const body = search ? { search } : {};

    return (await this.#client.call('querySkills', { id: this.id, body })).skills;
  }

  /** The history so far: it is saved, and continued from. */
  async messages(): Promise<HistoryMessage[]> {
    return (await this.#client.call('getMessages', { id: this.id })).messages;
  }

  /** The lines kept as queued behind a prompt, oldest first: pending input, outside the history. */
  async queue(): Promise<string[]> {
    return (await this.#client.call('getQueue', { id: this.id })).queued;
  }

  /** Keeps `queued` as the conversation's pending lines, replacing what was kept. */
  setQueue(queued: readonly string[]): Promise<void> {
    return this.#client.send('setQueue', { id: this.id, body: { queued: [...queued] } });
  }

  /** Switches to the model with this id, from the next model call; false when the conversation hasn't it. */
  async useModel(modelId: ModelId, effort?: ModelEffort): Promise<boolean> {
    try {
      await this.#client.send('switchModel', {
        id: this.id,
        body: { id: modelId, ...(effort && { effort }) },
      });
    } catch (caughtError) {
      // Only "no such model" is the user's to fix with another model; anything else is a failure.
      if (caughtError instanceof RefusedError && caughtError.code === 'unknown_model') {
        return false;
      }

      throw caughtError;
    }

    return true;
  }

  /**
   * Sends `text` to the conversation, which starts it at once or keeps it in its own queue behind
   * what runs (a prompt, or a run it started itself); the answer says which, with the lines
   * waiting. The run's entries come only on the conversation's stream (`follow`). Throws
   * `RefusedError` for a send the backend refused (`cannot_queue`, `unknown_skill`, ...).
   */
  submit(text: string): Promise<PromptSent> {
    return this.#client.call('sendPrompt', { id: this.id, body: { text } });
  }

  /**
   * Sends `text` and yields its run's entries, every session's, from its start to the main
   * session's `done`, whether it started at once or waited in the conversation's queue. Aborting
   * `signal` stops what the conversation runs on the backend; the entries still come, ending
   * with that `done`. Throws `BackendError` for a failed main run, `PromptRefusedError` for a
   * queued line that could not start, and `RefusedError` for a refused send.
   */
  async *send(params: { text: string; signal?: AbortSignal }): AsyncGenerator<StreamEntry> {
    const { text, signal } = params;
    const stop = () => void this.#client.send('stopPrompt', { id: this.id });

    signal?.addEventListener('abort', stop, { once: true });

    try {
      for await (const entry of promptEntries({
        client: this.#client,
        id: this.id,
        prompt: { text },
      })) {
        if (
          entry.kind === 'event' &&
          entry.event.type === 'run_failed' &&
          isMainSession(entry.event.session)
        ) {
          const error = entry.messageId
            ? `[message ${entry.messageId}] ${entry.event.error}`
            : entry.event.error;

          throw new BackendError({ message: error });
        }

        yield entry;

        if (runEnd(entry) === 'failed') {
          throw new BackendError({
            message:
              'The model run failed before completing. The backend log contains the original error.',
          });
        }
      }
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * The conversation's whole stream, from its start, as raw SSE: what a UI reads, for a run to
   * save. It ends when `signal` aborts.
   */
  rawStream(signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    return this.#client.open('streamConversation', { id: this.id, body: { replay: true }, signal });
  }

  /** Stops whatever the conversation runs now, a prompt or a run it started itself. */
  stop(): Promise<void> {
    return this.#client.send('stopPrompt', { id: this.id });
  }

  /**
   * Follows the conversation's live stream, every session's entries from now on, so a UI shows
   * what every run does: the prompts sent, the lines the backend starts from its queue, and the
   * runs it starts itself (it wakes the idle conversation when background work finishes). Entries
   * `send` yields arrive here too: a caller that reads both shows each once, by seq.
   * Resolves once the backend accepted the stream; `ended` resolves when `signal` aborts and
   * rejects when the stream is lost: a dropped or cut stream is reopened after the last entry
   * heard, and `StreamLostError` says when it gave up.
   */
  async follow(params: {
    onEntry: (entry: StreamEntry) => void;
    signal: AbortSignal;
  }): Promise<{ ended: Promise<void> }> {
    const { onEntry, signal } = params;
    const entries = await followConversation({
      client: this.#client,
      id: this.id,
      body: {},
      signal,
    });
    const ended = (async () => {
      for await (const entry of entries) onEntry(entry);
    })();

    return { ended };
  }

  /**
   * Answers the conversation's approvals through its tree channel: while the returned `ended` runs,
   * a command that needs one waits for the user instead of being refused at once. `onApproval` hears
   * each approval once when it shows in the tree (one already waiting when this connects included),
   * with the sub-agent that asked it, and `onGone` hears each one that no longer waits (answered by
   * this UI or another, or given up on).
   *
   * Resolves once the backend has accepted the connection, which is when it counts: an approval
   * asked before that is refused on the spot, so send the first prompt only after this resolves.
   * A dropped connection is resumed and tells nothing twice. `ended` resolves when `signal` aborts
   * and rejects when the tree channel fails (the conversation was closed), is refused or lost.
   */
  watchApprovals(params: {
    onApproval: (asked: AskedApproval) => void;
    onGone: (id: ApprovalId) => void;
    signal: AbortSignal;
  }): Promise<{ ended: Promise<void> }> {
    const { onApproval, onGone, signal } = params;

    return watchTreeApprovals({
      client: this.#client,
      id: this.id,
      signal,
      onGone,
      onApproval: ({ request, asker }) => {
        // Only a sub-agent is named: the main agent's approvals need no name.
        const subAgent =
          asker?.kind === 'agent' && asker.parent !== undefined
            ? { title: asker.title }
            : undefined;

        onApproval({ request, ...(subAgent && { asker: subAgent }) });
      },
    });
  }

  /** Answers a waiting approval. `unknown_approval` when it is gone: someone answered first. */
  answerApproval(params: { approval: ApprovalId; response: ApprovalResponse }): Promise<void> {
    return this.#client.send('answerApproval', {
      id: this.id,
      approval: params.approval,
      body: { response: params.response },
    });
  }

  /** Closes it on the backend: its prompts, background tasks and processes stop. */
  close(): Promise<void> {
    return this.#client.send('closeConversation', { id: this.id });
  }
}
