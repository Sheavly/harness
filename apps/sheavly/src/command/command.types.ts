/** Where the command line writes: tests pass collectors, the process passes its streams. */
export type Streams = {
  out: (text: string) => void;
  err: (text: string) => void;
};

/**
 * What a command does with the arguments after its name and the environment it was started in.
 * It resolves when it has started or finished its work (a server resolves once it listens and
 * keeps the process alive) and throws what the user should be told.
 */
export type CommandRun = (params: {
  args: readonly string[];
  env: NodeJS.ProcessEnv;
}) => Promise<void>;

/** One entry of the command table: what `--help` lists and what runs. */
export type CliCommand = {
  name: string;
  /** One line for the list in `sheavly --help`. */
  summary: string;
  /** The whole text of `sheavly <name> --help`. */
  help: string;
  run: CommandRun;
};
