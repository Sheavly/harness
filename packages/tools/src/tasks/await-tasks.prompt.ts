export const awaitTasksPrompts = {
  description:
    'Optional, and rarely needed: every finished finite background task is delivered to you automatically and wakes you, so never call this for one task or just to wait. ' +
    'Use it only when two or more results must reach you together before you can act: it holds their results back until every member finishes. ' +
    'Returns immediately; it does not block this call or poll. Then finish independent work and end your turn without tool calls. ' +
    'Give your future self enough context to use the results after a summary: explain what decision or next step depends on them. ' +
    'Do not use a generic reason such as "waiting for results". Inspect task_status only for requested updates or diagnosis.',
  ids: 'Task ids to group; each must exist and not already belong to a group.',
  reason:
    'Required context for your future self after a summary: why these results belong together and what to do with them. ' +
    'Explain the dependent decision or next step, not merely "waiting for results".',
};

/** IDs and reason have already been validated and registered as a group. */
export function groupedTasksPrompt(params: { ids: readonly string[]; reason: string }): string {
  const { ids, reason } = params;

  return (
    `Grouped tasks ${ids.join(', ')}. Their results will be delivered together when all members finish.\n` +
    `Reason: ${reason}\n` +
    'Finish independent work, then end your turn without tool calls; the grouped results wake you once every member has finished. Do not poll task_status.'
  );
}
