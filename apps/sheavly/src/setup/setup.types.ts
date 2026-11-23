import type { ChatServer } from '../chat/chat.types.js';

/** Runs the terminal's setup (`runTerminalSetup`) on `server`, one the finder found and verified. */
export type RunSetup = (params: { env: NodeJS.ProcessEnv; server: ChatServer }) => Promise<void>;

/**
 * Starts a server in this process for as long as setup runs (`startEmbeddedServer` of the
 * backend, handed in by `src/cli.ts` alone). `started`: it listens at `url` on loopback and is
 * findable through its discovery file, and `close` takes it down. `refused`: another server holds
 * the home's lock. `log` takes what it logs while it starts.
 */
export type StartPrivateServer = (params: {
  env: NodeJS.ProcessEnv;
  log: (text: string) => void;
}) => Promise<
  | { status: 'started'; url: string; close: () => Promise<void> }
  | { status: 'refused'; message: string }
>;

/** The server setup runs on, and how to end it when setup started it itself. */
export type ServerForSetup = { server: ChatServer; close?: () => Promise<void> };
