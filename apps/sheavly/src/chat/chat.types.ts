/** A running server the command found and verified: where it is, and the token it proved it holds. */
export type ChatServer = { url: string; token: string };

/**
 * A `ChatServer` with what the finder also knows of it: the server's own version (from its
 * discovery file) and the protocol version its handshake proved.
 */
export type VerifiedServer = ChatServer & { serverVersion: string; protocolVersion: string };

/** Runs the terminal's chat (`runTerminalChat`), on `server` when one was found. */
export type RunChat = (params: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  server?: ChatServer;
}) => Promise<void>;
