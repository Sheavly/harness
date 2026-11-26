import type {
  ApprovalId,
  ApprovalRequest,
  ApprovalResponse,
} from '@sheavly/protocol/approval/approval.types';
import type { ApprovalAsker } from '../client/client.types.js';
import { APPROVAL_LABELS, APPROVAL_ORDER } from './approval.constants.js';
import { keepsHint } from './keeps.utils.js';
import type { ApprovalChoice, ApprovalOutcome, ApprovalPhase } from './tui.types.js';

/**
 * The approvals waiting for the user's say, one question at a time. A command that needs an
 * answer waits on the backend, so the prompt only keeps what is asked: the order they came in, the
 * one shown, which choice is picked, and whether it is asking for a message.
 *
 * No choice is picked when a request is shown. Enter answers only a choice the user moved to or
 * numbered, so the Enter that sends a half-typed line, or a stray one, never runs a command.
 */
export class ApprovalPrompt {
  #queue: ApprovalRequest[] = [];
  /** Who asked each waiting request, when a sub-agent did; dropped with the request. */
  #agents = new Map<ApprovalId, ApprovalAsker>();
  #picked: number | undefined;
  #phase: ApprovalPhase = 'choose';

  /** The request being asked about, or undefined when none waits. */
  get current(): ApprovalRequest | undefined {
    return this.#queue[0];
  }

  /** How many wait behind the one shown. */
  get waiting(): number {
    return Math.max(0, this.#queue.length - 1);
  }

  get phase(): ApprovalPhase {
    return this.#phase;
  }

  /**
   * The options of the request shown, in the prompt's order, each with its label. "Always allow"
   * says what it would keep (the request's `keeps`), so the user agrees to those words and not to
   * a guess at them.
   */
  get choices(): ApprovalChoice[] {
    const offered = this.current?.options ?? [];
    const keeps = this.current?.keeps;

    return APPROVAL_ORDER.filter((option) => offered.includes(option)).map((option) => ({
      option,
      ...APPROVAL_LABELS[option],
      ...((option === 'always_allow' || option === 'allow_session') &&
        keeps &&
        keeps.length > 0 && {
          hint: keepsHint({ keeps, scope: option === 'allow_session' ? 'session' : 'workspace' }),
        }),
    }));
  }

  /** The picked choice's index, or undefined while nothing is picked. */
  get picked(): number | undefined {
    return this.#picked;
  }

  /** The sub-agent that asked the request shown; undefined for the main session or none shown. */
  get currentAgent(): ApprovalAsker | undefined {
    const request = this.current;

    return request ? this.#agents.get(request.id) : undefined;
  }

  /** Adds a request that was asked. One asked twice (a replay) is kept once. */
  ask(request: ApprovalRequest, agent?: ApprovalAsker): void {
    if (this.#queue.some(({ id }) => id === request.id)) {
      // A repeat may know who asked when the first delivery did not.
      if (agent && !this.#agents.has(request.id)) this.#agents.set(request.id, agent);

      return;
    }

    this.#queue.push(request);
    if (agent) this.#agents.set(request.id, agent);
    if (this.#queue.length === 1) this.#reset();
  }

  /** Removes a request that was answered elsewhere or given up on. */
  forget(id: ApprovalId): void {
    const wasCurrent = this.current?.id === id;

    this.#queue = this.#queue.filter((request) => request.id !== id);
    this.#agents.delete(id);
    if (wasCurrent) this.#reset();
  }

  /** Moves the pick by `step` choices, wrapping; the first move picks the first or last. */
  move(step: 1 | -1): void {
    const count = this.choices.length;

    if (count === 0 || this.#phase !== 'choose') return;
    if (this.#picked === undefined) this.#picked = step === 1 ? 0 : count - 1;
    else this.#picked = (this.#picked + step + count) % count;
  }

  /** Picks the choice with this number (from 1), when there is one. */
  pickNumber(number: number): void {
    if (this.#phase !== 'choose') return;
    if (number >= 1 && number <= this.choices.length) this.#picked = number - 1;
  }

  /**
   * Confirms the picked choice. Nothing picked: nothing happens. "Skip and say what to do" asks
   * for the message first (`needs_message`; then `answerWithMessage`); any other choice is the
   * answer, and its request is taken off the queue.
   */
  confirm(): ApprovalOutcome {
    const request = this.current;
    const choice = this.#picked === undefined ? undefined : this.choices[this.#picked];

    if (!request || !choice || this.#phase !== 'choose') return { kind: 'none' };

    if (choice.option === 'skip_with_message') {
      this.#phase = 'message';

      return { kind: 'needs_message' };
    }

    return this.#answer(request, { decision: choice.option });
  }

  /** Skips the request shown, the way Esc does; with a message, tells the model what instead. */
  skip(message?: string): ApprovalOutcome {
    const request = this.current;

    if (!request) return { kind: 'none' };

    const text = message?.trim();

    return this.#answer(
      request,
      text ? { decision: 'skip_with_message', message: text } : { decision: 'skip' },
    );
  }

  /** Goes back from typing a message to choosing. */
  cancelMessage(): void {
    if (this.#phase === 'message') this.#phase = 'choose';
  }

  /** Every request that waits, taken off the queue; for a prompt that was interrupted. */
  drain(): ApprovalRequest[] {
    const all = this.#queue;

    this.#queue = [];
    this.#agents.clear();
    this.#reset();

    return all;
  }

  #answer(request: ApprovalRequest, response: ApprovalResponse): ApprovalOutcome {
    this.#queue = this.#queue.filter(({ id }) => id !== request.id);
    this.#agents.delete(request.id);
    this.#reset();

    return { kind: 'answer', answer: { id: request.id, response } };
  }

  #reset(): void {
    this.#picked = undefined;
    this.#phase = 'choose';
  }
}
