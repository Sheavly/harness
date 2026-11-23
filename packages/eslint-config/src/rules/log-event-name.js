// An event name is a member of the calling module's `LOG_EVENT` (its constants file), never a
// string written at the call: the names are a catalogue, each with a meaning, that a derived
// suite checks (no duplicate, well formed, described, used). A literal or a template at the call
// is an event no catalogue knows. Not covered: a `LOG_EVENT` that is not the module's own, or an
// event held in a variable.

import { logCall } from './catch-scope.utils.js';

const MESSAGE =
  "Name the event with a member of this module's `LOG_EVENT`: `logger.error(LOG_EVENT.REQUEST_FAILED, { error })`. Add the event and its `LOG_EVENT_MEANING` to the module's constants file; a string at the call is an event no catalogue knows.";

/** Whether `node` is `LOG_EVENT.<NAME>`. */
function isCatalogueMember(node) {
  return (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.object.name === 'LOG_EVENT'
  );
}

export const logEventName = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { notMember: MESSAGE },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      CallExpression(node) {
        const call = logCall({ node, sourceCode });

        if (call && !isCatalogueMember(call.event)) {
          context.report({ node: call.event, messageId: 'notMember' });
        }
      },
    };
  },
};
