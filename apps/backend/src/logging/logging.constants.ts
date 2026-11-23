/** The service name on every entry the backend writes. */
export const LOG_SERVICE = 'backend';

/** Every event the backend logs: lowercase `<area>.<what_happened>`. One per place an error ends. */
export const LOG_EVENT = {
  API_REQUEST_FAILED: 'api.request_failed',
  PROMPT_FAILED: 'prompt.failed',
  WAKE_RUN_FAILED: 'conversation.wake_run_failed',
  EXTENSION_PROBLEM: 'extension.problem',
  FILE_READS_PROBLEM: 'file_reads.problem',
  WORKING_ROOT_FAILED: 'working_root.read_failed',
  SCRATCH_PRUNE_FAILED: 'scratch.prune_failed',
} as const;

/** @public Read as text by the log-event catalogue suite, never imported. */
export const LOG_EVENT_MEANING = {
  API_REQUEST_FAILED:
    'A request failed in a way the API answers as internal: the client was told only that, and this entry has the error with its stack and cause chain (fields: route, status, code, conversationId when the route has one).',
  PROMPT_FAILED:
    'A prompt the conversation ran itself, one submitted or queued, failed with nobody awaiting it; clients see the session go idle as failed (fields: conversationId, error).',
  WAKE_RUN_FAILED:
    'A run the conversation started by itself for finished background work failed, with no caller to throw to (fields: conversationId, error).',
  EXTENSION_PROBLEM:
    'An extension failed to activate or deactivate while the run went on without it (fields: conversationId, error).',
  FILE_READS_PROBLEM:
    'The conversation could not restore or keep the file reads that tell which files the agent has seen (fields: conversationId, error).',
  WORKING_ROOT_FAILED:
    'The conversation could not read its working root for the header a UI shows (fields: conversationId, error).',
  SCRATCH_PRUNE_FAILED:
    'Removing stale entries from the shared scratch folder at startup failed; the server started anyway (fields: error).',
} satisfies Record<keyof typeof LOG_EVENT, string>;
