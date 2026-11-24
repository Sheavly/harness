/** The wait before the first reconnect attempt; each one after doubles it. */
export const RECONNECT_INITIAL_MS = 250;

/** The longest wait between two attempts. */
export const RECONNECT_MAX_MS = 5000;

/**
 * How long a connection must stay open for the count of failed attempts to start again: an idle
 * stream a proxy cuts every so often (only heartbeats between) is healthy, not lost. The backend
 * sends a heartbeat every 15 s, so this is two of them.
 */
export const RECONNECT_STABLE_MS = 30_000;

/**
 * How long attempts in a row may fail, without an entry arriving, before the stream is given up
 * as lost: an hour, so a connection that is gone for a while (a network that dropped, a computer
 * that slept) is picked up again by the same stream when it returns. Time the machine slept does
 * not count where `performance.now()` stops while it does (Linux, macOS).
 */
export const RECONNECT_BUDGET_MS = 3_600_000;
