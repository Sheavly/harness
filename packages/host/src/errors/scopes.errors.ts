import type { SessionId } from '@sheavly/protocol/session/session.types';

/**
 * A scope method was called without something it must have, such as the session a task control
 * call is about: left out, it would read as every session of the run.
 */
export class ScopeArgumentError extends Error {
  override name = 'ScopeArgumentError';
}

/**
 * An approval request named a tool its extension does not contribute: with `approval:as-tool`,
 * an extension may only ask as a tool it contributes. A request made while `activate` runs, before
 * its contributions are checked, is refused too.
 */
export class ApprovalToolNotContributedError extends Error {
  override name = 'ApprovalToolNotContributedError';
  readonly extension: string;
  readonly tool: string;

  constructor(params: { extension: string; tool: string }) {
    const { extension, tool } = params;

    super(
      `Extension "${extension}" cannot ask for approval as "${tool}": it is not a tool the extension contributes (a request made during activate is refused too)`,
    );
    this.extension = extension;
    this.tool = tool;
  }
}

/**
 * A scope already holds the most it may (`MAX_SCOPE_CHILDREN` sub-agents not yet released): the
 * limit keeps one extension from filling the nodes the whole conversation shares.
 */
export class ScopeLimitError extends Error {
  override name = 'ScopeLimitError';
  readonly limit: number;

  constructor(params: { limit: number; what: string }) {
    super(
      `This scope already holds ${String(params.limit)} ${params.what}: wait for some to be released`,
    );
    this.limit = params.limit;
  }
}

/** `runChild` was called for a child whose run has not returned yet: one loop per session. */
export class ChildRunningError extends Error {
  override name = 'ChildRunningError';
  readonly sessionId: SessionId;

  constructor(params: { sessionId: SessionId }) {
    super(`Session ${params.sessionId} is already running; wait for its run to end`);
    this.sessionId = params.sessionId;
  }
}
