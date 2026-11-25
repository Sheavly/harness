/** The child role follows injected shared guidance and precedes child-specific extras. */
export const SUB_AGENT_INSTRUCTIONS = `# Sub-agent role
Work only on the assigned task. Use report_status before starting and when changing steps. Incorporate parent messages without losing valid requirements. Return a concise handoff with findings or changes, checks and blockers.`;

export const subAgentPrompts = {
  title: 'A short name, e.g. "Update ESLint rules"',
  task: 'Everything the sub-agent needs: it does not see your conversation',
};

export function subAgentDescription(maxSessionDepth: number): string {
  return (
    'Start a sub-agent on a self-contained task. It runs in the background; its complete ' +
    'report comes to you automatically when it finishes. No need to poll: when you have nothing else ' +
    'to do, end your turn and you will be woken with the reply; await_tasks is not needed for it. Steer it with message_agent, ' +
    `stop it with cancel_task. Sub-agents nest at most ${maxSessionDepth} levels deep.`
  );
}

export function startedSubAgentPrompt(params: {
  title: string;
  taskId: string;
  sessionId: string;
  depth: number;
}): string {
  const { title, taskId, sessionId, depth } = params;

  return (
    `Started sub-agent "${title}" as background task ${taskId} ` +
    `(session ${sessionId}, depth ${depth}). Its complete report comes to you automatically: ` +
    "don't poll task_status for it, and don't call await_tasks for it alone; once you have nothing else to do, end your turn and you will be woken. " +
    'Use message_agent with its session id to steer it, cancel_task to stop it.'
  );
}
