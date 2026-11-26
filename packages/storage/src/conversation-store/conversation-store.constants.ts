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
 * What a conversation's channels may hold unless the app says otherwise: 4 GiB for one channel,
 * 32 GiB for all of them, and 5,000 channels. A conversation used for weeks keeps its whole story in
 * its main agent's channel, and light turns measure about 10 KiB of channel each while a turn that
 * reads files and runs commands is several times that, so 128 MiB lasts a week or two of heavy use;
 * 4 GiB lasts months. A channel past a limit still refuses every later entry (it fails closed), and
 * what to drop from the oldest end is retention, not a limit.
 */
export const DEFAULT_CHANNEL_LIMITS = {
  channelBytes: 4 * 1024 * 1024 * 1024,
  conversationBytes: 32 * 1024 * 1024 * 1024,
  conversationChannels: 5000,
} as const;

/**
 * How many entries lie between two offsets a channel remembers: it keeps where every 1,024th line
 * starts, so a read from a cursor or a tail begins at most this many lines before the one it wants,
 * and the index of a channel of a million entries is a thousand numbers.
 */
export const CHANNEL_INDEX_EVERY = 1024;
