// Shell command reading shared by the beforeShellExecution guards. Best-effort by design:
// no regex reading of shell is complete (variables, eval, scripts written then run).
import { existsSync } from 'node:fs';
import path from 'node:path';

export function programName(token) {
  return path.basename(token).replace(/\.exe$/i, '');
}

/** Whether `file`, read from `cwd`, is outside `projectRoot` (so a write to it edits nothing there). */
export function isOutsideProject(params) {
  const { file, cwd, projectRoot } = params;
  const relative = path.relative(projectRoot, path.resolve(cwd, file));

  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

// Programs that only print or search their arguments, so a program named among them is a word,
// not a command (`echo sed -i`, `rg 'sed -i'`). Anything else before it is taken to run it.
const NON_EXECUTING_PROGRAMS = new Set([
  'echo',
  'printf',
  'cat',
  'rg',
  'grep',
  'ls',
  'git',
  'which',
  'type',
  'man',
  'jq',
  'head',
  'tail',
  'wc',
  'cut',
  // Rewrites the text it is given (stdin), never a file or another program.
  'tr',
  // Status reads: what a file or process is, never writing it.
  'stat',
  'ps',
  'sleep',
]);

/** Whether a segment's first word only prints or searches the rest, so none of it runs. */
export function startsWithNonExecuting(tokens) {
  return NON_EXECUTING_PROGRAMS.has(programName(tokens[0]));
}

// Commit/PR messages are prose that may *mention* forbidden flags or git commands, so their
// values are blanked before matching. Only quoted values and `"$(cat <<'EOF' …)"` heredocs are
// skipped, and only for commands where these flags carry prose: elsewhere `-b` is a branch.
const MESSAGE_FLAG = String.raw`(?:-m|-t|-b|--message|--title|--body|--notes)`;
const HEREDOC_MESSAGE = new RegExp(
  String.raw`(\s${MESSAGE_FLAG}[\s=]+)"\$\(cat <<-?\s*(['"]?)(\w+)\2\n[\s\S]*?\n\s*\3\s*\)"`,
  'g',
);
const QUOTED_MESSAGE = new RegExp(String.raw`(\s${MESSAGE_FLAG}[\s=]+)("[^"]*"|'[^']*')`, 'g');
const MESSAGE_COMMAND =
  /(?:^|[;&|\n])\s*(?:\w+=\S*\s+)*(?:\S*\/)?(?:git\b[^;&|\n]*\b(?:commit|tag|merge|stash|notes)|gh\s+(?:pr|issue|release))\b[^;&|\n]*$/;

// String.replace passes the match offset and whole string last, after every capture group.
function blankMessage(match, flag, ...rest) {
  const [offset, whole] = rest.slice(-2);

  return MESSAGE_COMMAND.test(whole.slice(0, offset)) ? `${flag}MESSAGE` : match;
}

export function stripMessages(command) {
  return command.replace(HEREDOC_MESSAGE, blankMessage).replace(QUOTED_MESSAGE, blankMessage);
}

// `git commit` options that reuse or generate the message instead of taking a new one.
const REUSED_MESSAGE =
  /(?:^|\s)(?:--no-edit|-[cC]|--reuse-message|--reedit-message|--fixup|--squash)(?:[\s=]|$)/;
const ANY_HEREDOC = /<<-?\s*(['"]?)(\w+)\1\n([\s\S]*?)\n\s*\2(?=\s|\)|$)/;
const MESSAGE_VALUE = /(?:^|\s)(?:-m|--message)(?:\s+|=)("((?:[^"\\]|\\.)*)"|'([^']*)')/g;
const FILE_VALUE = /(?:^|\s)(?:-F|--file)(?:\s+|=)(\S+)/;

// git's global options between `git` and `commit`: `-C <dir>`, `-c <k=v>`, the ones that name a
// repository or folder (`--git-dir`, `--work-tree`, with `=` or a space), and any other long flag
// (`--no-pager`), so none hides the commit from the guard.
const OPTION_VALUE = String.raw`(?:[^\s"']|"[^"]*"|'[^']*')+`;
const GIT_GLOBALS = String.raw`(?:\s+-[Cc]\s+${OPTION_VALUE}|\s+--(?:git-dir|work-tree|namespace|exec-path|super-prefix)(?:=|\s+)${OPTION_VALUE}|\s+--[a-z][a-z-]*(?:=\S+)?|\s+-[pP])*`;
const GIT_COMMIT = new RegExp(
  String.raw`(^|[;&|\n(]\s*|\s)(?:\S*\/)?git(${GIT_GLOBALS})\s+commit\b([\s\S]*)$`,
);

/**
 * The first `git … commit` of `command`: `before` (the command up to the `git` word), `globals`
 * (git's own options before `commit`) and `args` (the text after it), or null when it runs none.
 * One parse, so the message and the folder it is made in are read from the same commit.
 */
function findCommit(command) {
  const match = GIT_COMMIT.exec(command);

  if (!match) return null;

  return {
    before: command.slice(0, match.index + match[1].length),
    globals: match[2],
    args: untilNextCommand(match[3]),
  };
}

/**
 * `text` up to the first `;`, `&&`, `||` or `|` outside quotes: what follows is another command,
 * and its flags (`rg -C 2`, `git diff -C`) or heredoc (`gh pr create … <<EOF`) are not the commit's.
 * A newline ends it too, unless a heredoc was opened before it (`-F - <<EOF`: its body follows).
 */
function untilNextCommand(text) {
  let quote = null;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quote) {
      if (char === '\\' && quote === '"') index++;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ';' || char === '|' || (char === '&' && text[index + 1] === '&')) {
      return text.slice(0, index);
    } else if (char === '\n' && !text.slice(0, index).includes('<<')) {
      return text.slice(0, index);
    }
  }

  return text;
}

/** `args` without its quoted values and heredoc bodies: only its own flags are left. */
function flagsOf(args) {
  return args
    .replace(/<<-?\s*(['"]?)(\w+)\1\n[\s\S]*?\n\s*\2(?=\s|\)|$)/g, '')
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/**
 * The message a `git commit` in `command` would record, for checking before it runs:
 * - `{ message }` from its `-m` values (joined like git does) or the heredoc it reads (`-F -`,
 *   or `-m "$(cat <<'EOF' …)"`);
 * - `{ file }` when it reads `-F <path>`;
 * - `{ reused: true }` when it keeps or generates the message (`--no-edit`, `-C`, `--fixup`);
 * - `{ editor: true }` when git would open an editor, which hangs an agent;
 * - null when the command runs no commit.
 */
export function readCommitMessage(command) {
  const commit = findCommit(command);

  if (commit === null) return null;

  const { args } = commit;

  // Its own flags only: a message that mentions `-C` or `--no-edit` is still a message to check.
  if (REUSED_MESSAGE.test(flagsOf(args))) return { reused: true };

  const heredoc = ANY_HEREDOC.exec(args);

  if (heredoc) return { message: heredoc[3].trim() };

  const values = [...args.matchAll(MESSAGE_VALUE)].map(
    (match) => match[2]?.replace(/\\(.)/g, '$1') ?? match[3],
  );

  if (values.length > 0) return { message: values.join('\n\n').trim() };

  const file = FILE_VALUE.exec(args)?.[1];

  return file ? { file } : { editor: true };
}

const CD_BEFORE = /(?:^|[;&|\n('"]\s*)(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
const unquoted = (value) => value.replace(/^["']|["']$/g, '');
// A folder written so the shell, not this reader, decides it: a variable, `~`, a command, a glob,
// `cd -`, a quote left open by a space inside it, or a shell operator taken for the folder.
const UNREADABLE_FOLDER = /[$`~*?\s]|^-|^["'][^"']*$|^(?:&&|\|\||;|\|)$/;

/**
 * The folder the first `git commit` of `command` runs in, and whether that could be read: where
 * the shell starts (`cwd`), moved by every `cd` / `pushd <dir>` before the commit and by every
 * `git -C <dir>` before `commit`, in order, as the shell and git apply them. `unreadable` is true
 * when a folder is a variable, `~`, has a space, does not exist, or the commit names its
 * repository with `--git-dir` or `--work-tree`: the guard then asks for `git -C <absolute dir>`
 * instead of checking against a repository the commit may not land in.
 */
export function commitDirectory(params) {
  const { command, cwd } = params;
  const commit = findCommit(command);
  const targets = [
    ...[...(commit?.before ?? '').matchAll(CD_BEFORE)].map((match) => match[1]),
    ...[...(commit?.globals ?? '').matchAll(/\s+-C\s+("[^"]*"|'[^']*'|\S+)/g)].map(
      (match) => match[1],
    ),
  ];
  let dir = cwd;
  let unreadable = /--(?:git-dir|work-tree)\b/.test(commit?.globals ?? '');

  for (const target of targets) {
    if (UNREADABLE_FOLDER.test(target)) unreadable = true;
    else dir = path.resolve(dir, unquoted(target));
  }

  return { dir, unreadable: unreadable || (targets.length > 0 && !existsSync(dir)) };
}

/** The value of the first of `flags` (`-b x` or `--base=x`), or undefined. */
export function flagValue(params) {
  const { args, flags } = params;

  for (let index = 0; index < args.length; index++) {
    const [name, inline] = args[index].split(/=(.*)/s);

    if (flags.includes(name)) return inline ?? args[index + 1];
  }

  return undefined;
}

/** Positional args, skipping flags, redirections and the values of the flags in `valued`. */
export function positionals(params) {
  const { args, valued = [] } = params;
  const result = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    if (valued.includes(arg)) index++;
    else if (!arg.startsWith('-') && !/^\d*>/.test(arg)) result.push(arg);
  }

  return result;
}

// Quotes and escapes only change how the shell splits words, so dropping them turns
// `"git" push` and `bash -c "git push -f"` back into plain words to inspect. A `\` line
// continuation joins its lines first: they are one command.
export function normalize(command) {
  return command
    .replace(/\\\n/g, ' ')
    .replace(/["'\\]/g, '')
    .replace(/\$\(|`|\(|\)/g, ' ; ');
}

/**
 * `command` with the shell operators inside each quoted argument masked, so splitting it reads
 * only the shell's own: a `|` in an `rg 'cp|mv'` pattern, a `;` in a `node -e "x; y"` program or a
 * `(` in a regex stays in its word. For checks that read what runs as a program; one that must see
 * into `bash -c "…"` splits the raw command instead.
 */
export function maskQuotedOperators(command) {
  return command.replace(/"[^"]*"|'[^']*'/g, (quoted) => quoted.replace(/[|;&<>()`$\s]/g, '_'));
}

// `2>&1`-style fd duplications are one token so their `&` isn't read as a separator. A newline
// ends a command like `;` does.
const TOKEN = /\d*>&\d+|\d*>>?|\|\||&&|[|;&\n]|[^\s|;&<>]+/g;
const SEPARATORS = new Set(['|', '||', '&&', ';', '&', '\n']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The index of the line ending the heredoc `lines[index]` opens (past the end when unclosed). */
function heredocEnd(lines, index) {
  const opener = /<<-?\s*(['"]?)(\w+)\1/.exec(lines[index] ?? '');

  if (!opener) return undefined;

  const end = lines.findIndex((next, at) => at > index && next.trim() === opener[2]);

  return end === -1 ? lines.length : end;
}

/** `command` without its heredocs' bodies: a body is its command's input, never commands. */
export function withoutHeredocBodies(command) {
  const lines = command.split('\n');
  const kept = [];

  for (let index = 0; index < lines.length; index++) {
    kept.push(lines[index]);
    index = heredocEnd(lines, index) ?? index;
  }

  return kept.join('\n');
}

/** `line` split at `;`, `&&`, `||` and `|` outside quotes: a quoted program keeps its `;`s. */
function splitOutsideQuotes(line) {
  const parts = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];

    if (quote) {
      if (char === quote) quote = null;
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ';' || char === '|' || (char === '&' && line[index + 1] === '&')) {
      parts.push(current);
      current = '';
      if (line[index + 1] === char) index++;
    } else {
      current += char;
    }
  }

  return [...parts, current];
}

/** A command line's words, each with its quotes taken off (`'a b'` stays one word, `a b`). */
function wordsOf(raw) {
  return [...raw.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? '',
  );
}

/**
 * Shell words that only start or end a compound command: what runs is the command after them
 * (`do sed -i …`, `if cp …` run sed and cp), and a loop's header or a closer runs nothing of its
 * own.
 */
const KEYWORDS = new Set(['if', 'while', 'until', 'do', 'then', 'else', 'elif', '!', '{', 'time']);

/**
 * The simple commands of `command`, line by line, each with the heredoc it reads (the body of a
 * heredoc is that command's input, never commands of its own): `raw` keeps the quotes (a program's
 * string literals tell its paths), `words` has them off, leading keywords (`do`, `if`) and env
 * assignments dropped.
 */
export function splitCommands(command) {
  const commands = [];
  const lines = command.split('\n');

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const last = heredocEnd(lines, index);
    let heredoc;

    if (last !== undefined) {
      heredoc = lines.slice(index + 1, last).join('\n');
      index = last;
    }

    for (const part of splitOutsideQuotes(line)) {
      const raw = part.replace(/<<-?\s*(['"]?)\w+\1.*$/, '').trim();
      const words = wordsOf(raw);
      const first = words.findIndex((word) => !KEYWORDS.has(word) && !ENV_ASSIGNMENT.test(word));

      if (first !== -1) commands.push({ raw, words: words.slice(first), heredoc });
    }
  }

  return commands;
}

const CLOSERS = new Set(['done', 'fi', 'esac', '}']);
const LOOP_HEADER = /^(for|select)$/;

/** `tokens` without the keywords before its command; a loop header or closer is no command. */
function commandOfSegment(tokens) {
  let start = 0;

  while (KEYWORDS.has(tokens[start] ?? '')) start++;
  const rest = tokens.slice(start);

  // `for x in a b` names a variable and words; the body after `do` is its own segment.
  if (LOOP_HEADER.test(rest[0] ?? '') || CLOSERS.has(rest[0] ?? '')) return [];

  return rest.slice(
    Math.max(
      0,
      rest.findIndex((t) => !ENV_ASSIGNMENT.test(t)),
    ),
  );
}

/** The simple commands in a (normalized) command line, each as words without leading env assignments. */
export function toSegments(command) {
  const segments = [[]];

  for (const token of command.match(TOKEN) ?? []) {
    if (SEPARATORS.has(token)) segments.push([]);
    else segments.at(-1).push(token);
  }

  return segments.map(commandOfSegment).filter((tokens) => tokens.length > 0);
}
