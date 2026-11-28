/**
 * How a completed item ended: `completed`, `interrupted` (the run was stopped, or the connection
 * lost, while it was in progress) or `failed` (the run was stopped by a failure).
 */
export const ITEM_REASONS = ['completed', 'interrupted', 'failed'] as const;

/**
 * The most UTF-16 code units of text one `message` item, or one `item_delta`, holds. It is what a
 * stored text window is, so no reply can exceed what an entry stores: a longer one is a run of items.
 */
export const MAX_ITEM_TEXT_CHARS = 8_192;

/**
 * The most characters of a tool call's description an item holds. A model's call may carry any
 * length of it, so a header is cut to this and the wire refuses a longer one.
 */
export const MAX_ITEM_DESCRIPTION_CHARS = 300;
