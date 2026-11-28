/** The UTF-16 code units that start a surrogate pair: a text is never cut after one of them. */
export const HIGH_SURROGATES = { first: 0xd800, last: 0xdbff } as const;

/** The UTF-16 code units that end a surrogate pair: a text is never cut before one that follows a high unit. */
export const LOW_SURROGATES = { first: 0xdc00, last: 0xdfff } as const;
