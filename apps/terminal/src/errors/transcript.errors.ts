/**
 * The conversation's tree holds no main agent (an agent with no parent), so there is no channel to
 * read its transcript from.
 */
export class NoMainAgentError extends Error {
  override name = 'NoMainAgentError';

  constructor() {
    super('The conversation has no main agent to read a transcript from.');
  }
}
