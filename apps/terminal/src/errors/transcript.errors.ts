/**
 * The transcript feed ended while the chat still listened: the conversation or one of its channels
 * ended, and nothing more will come.
 */
export class TranscriptEndedError extends Error {
  override name = 'TranscriptEndedError';

  constructor() {
    super('the conversation ended');
  }
}

/**
 * The conversation's tree holds no main agent (an agent with no parent), so there is no channel to
 * read its transcript from, and no context to read its usage from.
 */
export class NoMainAgentError extends Error {
  override name = 'NoMainAgentError';

  constructor() {
    super('The conversation has no main agent to follow.');
  }
}
