/**
 * The argument as a message names it: an option's name as typed (`--port=…` for one with a
 * value), never a value or a bare word, which may be a secret pasted in the wrong place.
 */
function describeArgument(argument: string): string {
  const option = /^(--?[a-z0-9][a-z0-9-]{0,31})(=.*)?$/i.exec(argument);

  if (option?.[1] !== undefined) return `"${option[1]}${option[2] === undefined ? '' : '=…'}"`;

  if (argument === '--') return '"--"';

  return `of ${String(argument.length)} character${argument.length === 1 ? '' : 's'}`;
}

/**
 * The server was started with an argument it doesn't read. It is refused before anything starts,
 * so a mistyped flag (`--version`) never starts a server that prints its token. The message names
 * an option but never repeats a value, and the error keeps no copy of the argument.
 */
export class UnknownArgumentError extends Error {
  override name = 'UnknownArgumentError';

  constructor(params: { argument: string; known: readonly string[] }) {
    const { argument, known } = params;

    super(`Unknown argument ${describeArgument(argument)}: the server takes ${known.join(', ')}`);
  }
}
