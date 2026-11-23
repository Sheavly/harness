import type { Streams } from '../command/command.types.js';
import type { SERVICE_ACTIONS } from './service.constants.js';

export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/** The programs the command runs, by name: it never builds a shell line. */
export type SystemTool = 'systemctl' | 'loginctl' | 'journalctl';

/** What `execFile` handed its callback when a program failed: an exit code, or an error code. */
export type ExecFailure = { code?: number | string | undefined };

/** One program run: which, and with what arguments. */
export type SystemCall = { tool: SystemTool; args: readonly string[] };

/**
 * What a program did. `missing` is a program that is not installed, `failed` one that ran and
 * exited non-zero (its `code`), `ok` one that exited 0; `stdout` and `stderr` are its output.
 */
export type SystemResult = {
  status: 'ok' | 'failed' | 'missing';
  code: number;
  stdout: string;
  stderr: string;
};

/** How the command talks to systemd: injected, so a test plays systemd with fake programs. */
export type SystemTools = {
  run: (params: { tool: SystemTool; args: readonly string[] }) => Promise<SystemResult>;
  /**
   * Runs the program with the terminal as its output until it ends; resolves with its exit code,
   * or `missing` when it is not installed.
   */
  follow: (params: { tool: SystemTool; args: readonly string[] }) => Promise<number | 'missing'>;
};

/** What `createServiceCommand` is given of the process, so a test supplies its own. */
export type ServiceDeps = {
  platform: NodeJS.Platform;
  /** The absolute path of `node` and of the running command line file. */
  nodePath: string;
  cliPath: string;
  /** The user's own home folder (`os.homedir()`), where `~/.config` is, and their user id. */
  homeDir: string;
  uid: number;
  system: SystemTools;
  /** Whether a person can be asked, and how to ask them a yes or no question. */
  interactive: boolean;
  confirm: (question: string) => Promise<boolean>;
  streams: Streams;
};

/** The two files the service owns, and the Sheavly home they sit beside, by absolute path. */
export type ServiceFiles = { unit: string; tokenFile: string; home: string };
