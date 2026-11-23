/** The most characters one queued line may hold: a prompt, not a document. */
export const MAX_QUEUED_LINE_CHARS = 20_000;

/**
 * The most characters all queued lines may hold together. Each change to the queue is a stream
 * entry carrying it whole, and a conversation keeps its newest entries in memory: this bounds them.
 */
export const MAX_QUEUED_CHARS = 100_000;

/**
 * The most characters the path of an ignored settings file may hold on the wire: twice the longest
 * path an operating system takes, so a project path plus `/.sheavly/settings.json` always fits.
 */
export const MAX_IGNORED_SETTING_FILE_CHARS = 8192;

/** The most ignored settings entries listed in a conversation's details; the rest are only counted. */
export const MAX_IGNORED_SETTINGS = 20;
