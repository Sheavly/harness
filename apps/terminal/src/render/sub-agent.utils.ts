import type { SessionUpdate } from '@sheavly/protocol/session/session.types';
import type { ChatItem } from '../client/transcript.types.js';
import type { Look } from './render.types.js';
import { firstLine, shortId } from './render.utils.js';
import { plainTerminalText } from './terminal-text.utils.js';

/**
 * The line a sub-agent's card says, from the transcript feed: where it starts, what it says it is
 * doing, and how it ended (its last run's outcome when it has one, which keeps what the node's
 * state folds together: `interrupted`, `max_turns`). Indented by how deep it sits.
 */
export function cardLine(params: {
  look: Look;
  item: Extract<ChatItem, { type: 'agent' }>;
}): string {
  const { look, item } = params;
  const { agent } = item;
  // The title and the status are free text and are escaped; the ids and the outcome are not text
  // a backend chooses freely: the client's schema holds the ids to a letters-and-digits form and
  // the outcome and state to a fixed set, before an item exists.
  const drawn = {
    indent: '  '.repeat(agent.depth - 1),
    title: plainTerminalText(agent.title),
    id: agent.id,
  };

  switch (item.change) {
    case 'started':
      return look.subAgentStarted({
        ...drawn,
        depth: agent.depth,
        parent: agent.parent,
        root: agent.root,
      });
    case 'status':
      return look.subAgentStatus({ ...drawn, status: plainTerminalText(agent.status ?? '') });
    case 'ended':
      return look.subAgentEnded({ ...drawn, state: agent.outcome ?? agent.state });
  }
}

/**
 * The line a session update says, from the conversation's stream: a sub-agent starting, reporting
 * status, getting a message or ending. `''` for the main session, which is not a card, and for the
 * updates that are not transcript output.
 */
export function sessionLine(params: { look: Look; update: SessionUpdate }): string {
  const { look, update } = params;
  const { session } = update;

  if (!('parentId' in session)) return '';

  const agent = {
    indent: '  '.repeat(session.depth - 1),
    title: plainTerminalText(session.title),
    id: session.id,
  };

  // Every update kind is chosen here, so a new one fails lint until it is drawn or ignored.
  switch (update.type) {
    case 'session_started':
      return look.subAgentStarted({
        ...agent,
        depth: session.depth,
        parent: session.parentId,
        root: session.rootId,
      });
    case 'session_status':
      return look.subAgentStatus({ ...agent, status: plainTerminalText(session.status ?? '') });

    case 'session_message': {
      const from = update.message.from === 'user' ? 'the user' : shortId(update.message.from);

      return look.subAgentMessage({ ...agent, from, content: firstLine(update.message.content) });
    }

    case 'session_ended':
      return look.subAgentEnded({ ...agent, state: session.state });
    case 'session_idle':
    case 'session_resumed':
    case 'session_model':
    case 'session_released':
      // Drawn by nothing: idle, resume and model changes are not transcript output, and the
      // ended card is already in the scrollback when a session is released.
      return '';
  }
}
