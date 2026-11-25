/**
 * Maximum length of the error text a `model_connection` report carries. A provider's error text
 * is cut at 500 characters (`providerErrorText`), so this leaves room for what a call adds to it.
 */
export const MAX_CONNECTION_ERROR_CHARS = 1000;
