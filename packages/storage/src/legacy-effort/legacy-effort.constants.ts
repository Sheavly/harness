/**
 * The message id a stored `prompt_started` or `prompt_refused` stream entry is read with when it was
 * written before a queued line had one. The entry is history: nothing waits on it, so the id names no
 * real message and is the same for every such entry.
 */
export const LEGACY_QUEUE_MESSAGE_ID = '00000000-0000-4000-8000-000000000000';
