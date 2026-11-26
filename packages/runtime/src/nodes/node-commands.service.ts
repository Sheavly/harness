import type { NodeId } from '@sheavly/protocol/node/node.types';
import type { SessionId } from '@sheavly/protocol/session/session.types';
import type { TaskId } from '@sheavly/protocol/task/task.types';
import { NodeCommandError } from '../errors/node-commands.errors.js';
import type { SessionRegistry } from '../sessions/sessions.service.js';
import type { TaskRegistry } from '../tasks/tasks.service.js';
import { SessionError } from '../errors/sessions.errors.js';
import { NODE_CANCEL_WAIT_MS } from './nodes.constants.js';
import type { NodeRecord, NodeTarget } from './nodes.types.js';
import { isOpenState } from './nodes.utils.js';

/**
 * The commands a client gives a node by its id (`POST …/nodes/{node}/cancel` and `…/messages`),
 * resolved to what the node is: an agent's session, a task, or neither. The node is looked up in
 * this conversation's registry alone, so a node of another conversation is as unknown as one that
 * never was, and a node that exists but has ended is told apart from one that does not (`node_ended`).
 * Both are decided before anything is done.
 *
 * It holds no state of its own. A command is the user's: a message is sent as the user sends it, so
 * the rule that a sub-agent is messaged only by the agent that started it holds here too.
 */
export class NodeCommands {
  readonly #sessions: SessionRegistry;
  readonly #tasks: TaskRegistry;
  readonly #cancelWaitMs: number;

  /** `cancelWaitMs` is for tests: the default is `NODE_CANCEL_WAIT_MS`. */
  constructor(params: {
    sessions: SessionRegistry;
    tasks: TaskRegistry;
    cancelWaitMs?: number | undefined;
  }) {
    this.#sessions = params.sessions;
    this.#tasks = params.tasks;
    this.#cancelWaitMs = params.cancelWaitMs ?? NODE_CANCEL_WAIT_MS;
  }

  /**
   * What a command to `nodeId` reaches. Throws `NodeCommandError`: `unknown_node` for a node this
   * conversation does not have, `node_ended` for one that has ended.
   */
  target(nodeId: NodeId): NodeTarget {
    const node = this.#sessions.nodes.get(nodeId);

    if (!node) {
      // A finished node is released once its end is reported, soon after it ends: it was this
      // conversation's and it is over, which is not the same as one that never was.
      if (this.#sessions.nodes.isReleased(nodeId)) {
        throw new NodeCommandError({
          reason: 'node_ended',
          nodeId,
          message: `Node ${nodeId} has ended and was released: nothing can be sent to it`,
        });
      }

      throw new NodeCommandError({
        reason: 'unknown_node',
        nodeId,
        message: `No node ${nodeId} in this conversation`,
      });
    }

    if (!isOpenState(node.state)) {
      throw new NodeCommandError({
        reason: 'node_ended',
        nodeId,
        message: `Node ${nodeId} has ended (${node.state}): nothing can be sent to it`,
      });
    }

    return this.#targetOf(node);
  }

  /**
   * Cancels a command, a service or a sub-agent with the kill the agents' `cancel_task` has, and
   * waits until it has exited, for at most `NODE_CANCEL_WAIT_MS`: a process that cannot be killed
   * never ends its task, and the answer is then that the kill was sent. The main agent is stopped by
   * the conversation (its prompt's stop switch), which this does not hold, so it is refused here, as
   * is a kind nothing can cancel.
   */
  async cancel(params: { nodeId: NodeId; target: NodeTarget }): Promise<void> {
    const { nodeId, target } = params;

    if (target.kind === 'work' || target.kind === 'sub-agent') {
      await this.#exitedOrWaited(this.#tasks.cancel(target.taskId));

      return;
    }

    throw new NodeCommandError({
      reason: 'cannot_cancel',
      nodeId,
      message: this.#cannotCancel({ nodeId, target }),
    });
  }

  /**
   * Sends `text` to an agent node as the user: the main agent sees it at its next model call (an
   * idle one at its next prompt). A sub-agent is messaged only by the agent that started it, and a
   * command, a service or an extension's node is no agent, so each is refused (`cannot_message`).
   */
  message(params: { nodeId: NodeId; target: NodeTarget; text: string }): void {
    const { nodeId, target, text } = params;

    if (target.kind === 'main-agent') {
      this.#sendToMain({ nodeId, sessionId: target.sessionId, text });

      return;
    }

    throw new NodeCommandError({
      reason: 'cannot_message',
      nodeId,
      message:
        target.kind === 'sub-agent'
          ? `Node ${nodeId} is a sub-agent: only the agent that started it can message it`
          : `Node ${nodeId} is not an agent: only an agent takes a message`,
    });
  }

  /** What a cancel that is refused says: the main agent is stopped by its prompt, the rest cannot be. */
  #cannotCancel(params: { nodeId: NodeId; target: NodeTarget }): string {
    const { nodeId, target } = params;

    if (target.kind === 'main-agent') {
      return `Node ${nodeId} is the main agent: stop its prompt instead`;
    }

    if (target.kind === 'other' && target.nodeKind === 'agent') {
      return `Node ${nodeId} is a sub-agent that nothing runs: there is nothing to cancel`;
    }

    return `Node ${nodeId} is of a kind (${target.kind === 'other' ? target.nodeKind : target.kind}) that cannot be cancelled`;
  }

  /** Waits for `exited`, or until `cancelWaitMs` has passed, whichever is first. */
  async #exitedOrWaited(exited: Promise<unknown>): Promise<void> {
    const waited = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => waited.resolve(undefined), this.#cancelWaitMs);

    try {
      await Promise.race([exited, waited.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends to the main agent as the user, telling an ended session and a full inbox as what they are. */
  #sendToMain(params: { nodeId: NodeId; sessionId: SessionId; text: string }): void {
    const { nodeId, sessionId, text } = params;

    try {
      this.#sessions.send({ id: sessionId, content: text, from: 'user' });
    } catch (caughtError) {
      if (caughtError instanceof SessionError && caughtError.reason === 'inbox_full') {
        throw new NodeCommandError({ reason: 'inbox_full', nodeId, message: caughtError.message });
      }

      if (caughtError instanceof SessionError && caughtError.reason === 'session_ended') {
        throw new NodeCommandError({ reason: 'node_ended', nodeId, message: caughtError.message });
      }

      throw caughtError;
    }
  }

  #targetOf(node: NodeRecord): NodeTarget {
    if (node.kind === 'agent') return this.#agentTarget(node);

    const taskId =
      node.kind === 'command' || node.kind === 'service' ? this.#taskOf(node.id) : undefined;

    return taskId === undefined ? { kind: 'other', nodeKind: node.kind } : { kind: 'work', taskId };
  }

  #agentTarget(node: NodeRecord): NodeTarget {
    const sessionId = this.#sessionOf(node.id);
    const taskId = this.#taskOf(node.id);

    if (sessionId === undefined) return { kind: 'other', nodeKind: node.kind };

    if (node.parent === undefined) return { kind: 'main-agent', sessionId };

    // A sub-agent is stopped through the task that runs it: with none, nothing can stop it.
    return taskId === undefined
      ? { kind: 'other', nodeKind: node.kind }
      : { kind: 'sub-agent', sessionId, taskId };
  }

  /** The session that is the agent node `nodeId`: the registry knows a session's node, not the way back. */
  #sessionOf(nodeId: NodeId): SessionId | undefined {
    return this.#sessions.list().find((session) => this.#sessions.nodeIdOf(session.id) === nodeId)
      ?.id;
  }

  /** The task that runs the node `nodeId`: a task shares its sub-agent's node, or has its own. */
  #taskOf(nodeId: NodeId): TaskId | undefined {
    return this.#tasks.list().find((task) => this.#tasks.nodeIdOf(task.id) === nodeId)?.id;
  }
}
