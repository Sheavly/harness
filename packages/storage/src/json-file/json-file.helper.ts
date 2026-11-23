import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { z } from 'zod';
import { parseOrThrow } from '@sheavly/core/validation/validation.validator';
import { errorCode, errorMessage, isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { StorageFileError } from '../errors/storage.errors.js';
import {
  BUSY_FILE_CODES,
  BYTE_ORDER_MARK,
  GROUP_AND_OTHERS,
  PRIVATE_FILE_MODE,
  PRIVATE_FOLDER_MODE,
  RENAME_ATTEMPTS,
  RENAME_RETRY_DELAY_MS,
} from './json-file.constants.js';

/**
 * The JSON in `file`, validated with `schema`, or `undefined` when there is no such file (nothing
 * stored yet). Anything else wrong with it, whether unreadable, not JSON or not what `schema`
 * says, throws a `StorageFileError` that names the file: a stored file is never taken for empty.
 * A leading byte-order mark is ignored, as some Windows editors add one to a file saved by hand.
 *
 * `holdsSecrets` is required so each reader decides. True for a file with keys or private text in
 * it: the parser's own message quotes the text around the fault, so a file that is not JSON is
 * reported without it (and without the error behind it as `cause`).
 */
export async function readJsonFile<TSchema extends z.ZodType>(params: {
  file: string;
  schema: TSchema;
  holdsSecrets: boolean;
}): Promise<z.infer<TSchema> | undefined> {
  const { file, schema, holdsSecrets } = params;
  let text: string;

  try {
    text = await readFile(file, 'utf8');
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return undefined;
    throw new StorageFileError({ file, cause: caughtError });
  }

  let json: unknown;

  try {
    json = JSON.parse(text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text);
  } catch (caughtError) {
    if (holdsSecrets) {
      throw new StorageFileError({
        file,
        cause: undefined,
        reason: 'it is not valid JSON (what it holds is not shown: it has secrets in it)',
      });
    }

    throw new StorageFileError({ file, cause: caughtError });
  }

  return parseOrThrow({
    schema,
    input: json,
    onInvalid: ({ details, error }) =>
      new StorageFileError({ file, cause: error, reason: `invalid:\n${details}` }),
  });
}

/**
 * Throws a `StorageFileError` if `file` can be read by anyone but its owner, as `ssh` refuses a
 * key that others can read: what was in it may already have been seen, so the message says to
 * restrict it and to replace what it holds. A file that is not there passes. Windows has no file
 * modes to check, so nothing is checked there.
 */
export async function assertPrivateFile(params: { file: string }): Promise<void> {
  const { file } = params;

  if (process.platform === 'win32') return;

  let mode: number;

  try {
    ({ mode } = await stat(file));
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return;
    throw new StorageFileError({ file, cause: caughtError });
  }

  if ((mode & GROUP_AND_OTHERS) === 0) return;

  throw new StorageFileError({
    file,
    cause: undefined,
    reason: `it can be read by other users (mode ${(mode & 0o777).toString(8)}). Restrict it to yourself (chmod 600), and replace the secrets in it, which others may have seen`,
  });
}

/**
 * Writes `value` to `file` as JSON, creating its folders, private to the user where the system
 * has file modes (`PRIVATE_FILE_MODE`). The file is replaced whole: written to a temp file beside
 * it and renamed into place, so a crash or a second write at the same moment never leaves half a
 * file. The temp name is unique per call, so writes to one file in one process don't share it.
 * Throws a `StorageFileError` naming `file`; the temp file is removed.
 */
export async function writeJsonFile(params: { file: string; value: unknown }): Promise<void> {
  const { file, value } = params;
  let text: string;

  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch (caughtError) {
    throw new StorageFileError({ file, cause: caughtError });
  }

  await writeTextFile({ file, text });
}

/**
 * Writes `text` to `file` as it is, with the guarantees of `writeJsonFile`: for a file the user's
 * tools read that is not JSON (a token in an environment file, a service's unit). Throws a
 * `StorageFileError` naming `file` and never holding the text.
 */
export async function writeTextFile(params: { file: string; text: string }): Promise<void> {
  const { file, text } = params;
  const temp = `${file}.${randomUUID()}.tmp`;

  try {
    await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_FOLDER_MODE });
    await writeFile(temp, text, { mode: PRIVATE_FILE_MODE });
    await replaceFile({ from: temp, to: file });
  } catch (caughtError) {
    await discardTemp({ temp, file, writeError: caughtError });
    throw new StorageFileError({ file, cause: caughtError });
  }
}

/**
 * Deletes the file `file`. Nothing there is fine, and the answer says which it was: `true` when a
 * file was removed. It removes one file and never a folder or what a link points to. Throws a
 * `StorageFileError` naming `file` for anything else (a folder, no permission).
 */
export async function removeTextFile(params: { file: string }): Promise<boolean> {
  const { file } = params;

  try {
    await unlink(file);

    return true;
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return false;

    throw new StorageFileError({ file, cause: caughtError });
  }
}

/**
 * Moves `from` over `to`. While another program briefly holds a file, Windows refuses the rename
 * (`EPERM`, `EBUSY`, `EACCES`); it is tried again a few times, a little longer apart each time,
 * and any other error, or the last of those, is thrown at once. `rename` is the move itself,
 * replaceable so a test can play a busy file.
 */
export async function replaceFile(params: {
  from: string;
  to: string;
  rename?: typeof rename;
}): Promise<void> {
  const { from, to, rename: move = rename } = params;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await move(from, to);

      return;
    } catch (caughtError) {
      const busy = BUSY_FILE_CODES.includes(errorCode(caughtError) ?? '');

      if (!busy || attempt === RENAME_ATTEMPTS) throw caughtError;
    }

    await sleep(RENAME_RETRY_DELAY_MS * attempt);
  }
}

/**
 * Removes the temp file of a write that failed. If that fails too (a locked file on Windows), both
 * errors are reported, so the stray file is named and the write's own error isn't lost.
 */
async function discardTemp(params: {
  temp: string;
  file: string;
  writeError: unknown;
}): Promise<void> {
  const { temp, file, writeError } = params;

  try {
    await rm(temp, { force: true });
  } catch (caughtError) {
    throw new StorageFileError({
      file,
      cause: new AggregateError([writeError, caughtError], 'The write and its cleanup failed'),
      reason: `${errorMessage(writeError)}; and ${temp} could not be removed: ${errorMessage(caughtError)}`,
    });
  }
}
