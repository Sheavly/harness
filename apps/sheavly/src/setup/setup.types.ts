import type { ChatServer } from '../chat/chat.types.js';

/** Runs the terminal's setup (`runTerminalSetup`) on `server`, one the finder found and verified. */
export type RunSetup = (params: { env: NodeJS.ProcessEnv; server: ChatServer }) => Promise<void>;
