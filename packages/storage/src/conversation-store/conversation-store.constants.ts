/** The folder under a workspace's folder that holds its conversations, one folder each. */
export const CONVERSATIONS_FOLDER = 'conversations';

/** A conversation's index entry, inside its folder. */
export const INDEX_FILE = 'index.json';

/** A conversation's stream, one entry per line, in `seq` order. */
export const STREAM_FILE = 'stream.jsonl';

/**
 * A conversation's log, one `LogEntry` per line: the failures the stream records (rebuilt from it
 * when a write is lost) and what the backend logs about the conversation (`jq` reads it).
 */
export const LOG_FILE = 'log.jsonl';

/** The events the conversation log records from the stream; the backend's own are its constants'. */
export const LOG_EVENT = {
  RUN_FAILED: 'run.failed',
  HOOK_FAILED: 'hook.failed',
  TOOL_FAILED: 'tool.failed',
} as const;

/** @public Read as text by the log-event catalogue suite, never imported. */
export const LOG_EVENT_MEANING = {
  RUN_FAILED:
    'A model run failed: the stream recorded run_failed (fields: seq, sessionId, messageId, modelId, the error text and its captured details).',
  HOOK_FAILED:
    'A hook handler threw during a run, which went on: the stream recorded hook_failed (fields: seq, sessionId, hook, handler, the error text).',
  TOOL_FAILED:
    'A tool call ended with an error result: the stream recorded it (fields: seq, sessionId, toolCallId, toolName, the error text, never the input).',
} satisfies Record<keyof typeof LOG_EVENT, string>;

/** The main session's durable history log, one record per line, in `seq` order. */
export const HISTORY_LOG_FILE = 'history.jsonl';

/** A sub-agent's durable history log is `agents/<session-id>.history.jsonl`. */
export const AGENT_HISTORY_LOG_SUFFIX = '.history.jsonl';

/** Where the conversation's agents work from, shared by the main session and its sub-agents. */
export const SHELL_FILE = 'shell.json';

/** The folder in a conversation's folder that holds its complete command output logs. */
export const OUTPUTS_FOLDER = 'outputs';

/** The lines queued behind a running prompt: outside history, kept across a restart. */
export const QUEUE_FILE = 'queue.json';

/** The folder in a conversation's folder that holds each sub-agent's history. */
export const AGENTS_FOLDER = 'agents';

/** The folder in a conversation's folder that holds each channel's log, `<channel>.jsonl`. */
export const CHANNELS_FOLDER = 'channels';

/** A channel's log is `channels/<channel>.jsonl`: an entry a line, in the channel's own order. */
export const CHANNEL_LOG_SUFFIX = '.jsonl';

/** What a channel that refused an entry for a limit leaves beside its log: `<channel>.full`. */
export const CHANNEL_FULL_SUFFIX = '.full';

/**
 * What a conversation's channels may hold unless the app says otherwise, the same as its command
 * output may: 128 MiB for one channel, 1 GiB for all of them, and 5,000 channels.
 */
export const DEFAULT_CHANNEL_LIMITS = {
  channelBytes: 128 * 1024 * 1024,
  conversationBytes: 1024 * 1024 * 1024,
  conversationChannels: 5000,
} as const;
