import type { ReconnectPolicy } from '@sheavly/client/client/client.types';
import type { ApprovalRequest } from '@sheavly/protocol/approval/approval.types';
import type { ContextFill, UsageFigures } from '@sheavly/protocol/usage/usage.types';

/** The sub-agent that asked an approval, as the screen shows it: by its title, never by an id. */
export type ApprovalAsker = { title: string };

/**
 * An approval that waits, as the chat and the workbook handle it: the request, and the sub-agent
 * that asked it. `asker` is unset for the main agent, whose approvals need no name.
 */
export type AskedApproval = { request: ApprovalRequest; asker?: ApprovalAsker };

/** How the terminal reaches a backend: its settings, the CLI arguments it passes on, its output. */
export type BackendOptions = {
  /** This run's environment: `BACKEND_URL`/`BACKEND_TOKEN`, or the settings a started one reads. */
  env: NodeJS.ProcessEnv;
  /** Passed to a backend it starts (`--trust`). */
  args?: readonly string[];
  /** A started backend's output (its notices, model calls), as it comes. */
  onOutput: (text: string) => void;
  /** Aborting while a backend starts stops it and rejects: Ctrl+C during startup. */
  signal?: AbortSignal;
};

/**
 * A running backend the caller found and verified itself (the `sheavly` command, through the
 * discovery file): the terminal connects to it as it does to `BACKEND_URL`, so `--trust` is sent
 * to it, and never starts or stops it.
 */
export type FoundBackend = { url: string; token: string };

/**
 * The background work still running under the conversation's main agent: commands (and any other
 * kind of node that is not one of the next two), sub-agents and services.
 */
export type Background = { tasks: number; agents: number; services: number };

/**
 * What the status line shows of the conversation's usage: the figures of every model call, and how
 * full the main agent's context is (unset until its first call).
 */
export type MainUsage = { total: UsageFigures; context: ContextFill | undefined };

/**
 * A backend the terminal talks to; `stop` ends it if the terminal started it: SIGTERM to its
 * process group, then SIGKILL after `timeoutMs`. Calling it again returns the same stop. `fetch`
 * reaches it (the global one when unset): another transport, or a server app in the same process.
 */
export type Backend = {
  url: string;
  token: string;
  /** Set when the terminal only connected to a backend that was already running (`BACKEND_URL`). */
  attached?: true;
  stop: (options?: { timeoutMs?: number }) => Promise<void>;
  fetch?: typeof fetch;
  /** How its streams reconnect after a drop: the client's defaults unless a test says otherwise. */
  reconnect?: ReconnectPolicy;
};
