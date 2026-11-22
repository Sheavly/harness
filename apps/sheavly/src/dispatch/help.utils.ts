import type { CliCommand } from '../command/command.types.js';

/** The text of `sheavly --help`: the commands of the table, and the two options of its own. */
export function renderHelp(commands: readonly CliCommand[]): string {
  const width = Math.max(...commands.map(({ name }) => name.length));
  const rows = [...commands]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, summary }) => `  ${name.padEnd(width)}  ${summary}`);

  return [
    'Usage: sheavly <command> [options]',
    '',
    'Commands:',
    ...rows,
    '',
    'Options:',
    '  --version  Print the version',
    '  --help     Show this help; `sheavly <command> --help` shows a command',
    '',
  ].join('\n');
}
