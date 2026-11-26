import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { validate } from '@sheavly/core/validation/validation.validator';
import { isMissingPath } from '@sheavly/runtime/errors/errors.utils';
import { StorageFileError } from '../errors/storage.errors.js';
import { PRIVATE_FILE_MODE, PRIVATE_FOLDER_MODE } from '../json-file/json-file.constants.js';
import { MAX_LINE_CHARS, NEWLINE, TAIL_BLOCK_BYTES } from './jsonl-file.constants.js';

/**
 * Adds `value` to the end of `file` as one JSON line, creating the file and its folders, private to
 * the user where the system has file modes. Throws a `StorageFileError` naming `file`. Lines are
 * appended one at a time: whoever appends several in a row waits for each (see `SerialQueue`).
 */
export async function appendJsonLine(params: { file: string; value: unknown }): Promise<void> {
  const { file, value } = params;

  try {
    await mkdir(path.dirname(file), { recursive: true, mode: PRIVATE_FOLDER_MODE });
    await appendFile(file, `${JSON.stringify(value)}\n`, { mode: PRIVATE_FILE_MODE });
  } catch (caughtError) {
    throw new StorageFileError({ file, cause: caughtError });
  }
}

/**
 * The lines of `file` as `schema` values, oldest first, read as a stream so a long file is never
 * held whole. No file yields nothing. Throws a `StorageFileError` naming the file and the line for
 * a line that is not JSON or not what `schema` says, and never quotes it: a conversation holds
 * private text. A last line with no newline after it is a write that was cut off, and is not read.
 * A line longer than `maxLineChars` (default `MAX_LINE_CHARS`, counted in bytes, which is what a
 * file holds) is refused the same way, before more of it is read, so a file without newlines cannot
 * fill memory. That includes an unterminated last line, which is refused rather than skipped.
 */
export async function* readJsonLines<TSchema extends z.ZodType>(params: {
  file: string;
  schema: TSchema;
  maxLineChars?: number;
}): AsyncGenerator<z.infer<TSchema>> {
  for await (const { value } of readJsonLinesAt(params)) yield value;
}

/**
 * `readJsonLines`, with where each line starts: its byte offset in the file. It may begin at a line
 * the caller knows the offset of (`start`, which must be the start of a line, and `firstLine`, the
 * number that line has, so an error names the right one), so a long file is not read from its first
 * line to reach one near its end.
 */
export async function* readJsonLinesAt<TSchema extends z.ZodType>(params: {
  file: string;
  schema: TSchema;
  maxLineChars?: number;
  start?: number;
  firstLine?: number;
}): AsyncGenerator<{ value: z.infer<TSchema>; offset: number }> {
  const { file, schema, maxLineChars = MAX_LINE_CHARS, start = 0, firstLine = 1 } = params;
  // The bytes of the line being read, as the file has them: a line's place is counted in them, so it
  // is exact whatever the text is (a byte that is not UTF-8 is read as one replacement character, and
  // counting that character would put every later place wrong).
  let pending = Buffer.alloc(0);
  let lineNumber = firstLine - 1;
  let offset = start;
  // Where the next newline search starts: bytes before it are already known to hold none, so a very
  // long line is scanned once rather than again for every chunk that extends it.
  let searchFrom = 0;

  try {
    for await (const chunk of createReadStream(file, { start })) {
      pending = Buffer.concat([pending, asBuffer(chunk)]);

      for (
        let end = pending.indexOf(NEWLINE, searchFrom);
        end !== -1;
        end = pending.indexOf(NEWLINE)
      ) {
        lineNumber += 1;
        assertShortLine({ length: end, maxLineChars, file, lineNumber });

        const text = pending.toString('utf8', 0, end);

        yield { value: parseLine({ text, schema, file, lineNumber }), offset };
        offset += end + 1;
        pending = pending.subarray(end + 1);
        searchFrom = 0;
      }

      searchFrom = pending.length;
      assertShortLine({ length: pending.length, maxLineChars, file, lineNumber: lineNumber + 1 });
    }
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return;
    if (caughtError instanceof StorageFileError) throw caughtError;
    throw new StorageFileError({ file, cause: caughtError });
  }
}

/** A chunk of a read stream opened with no encoding, as the bytes it is. */
function asBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
}

/**
 * Cuts a last line that has no newline after it from `file`: a write that was cut off by a crash.
 * Without it, the next line appended would join onto the half-written one. A file that ends in a
 * newline, or is not there, is left alone. Returns how many bytes were cut.
 */
export async function trimPartialLine(params: { file: string }): Promise<number> {
  const { file } = params;

  try {
    const { size } = await stat(file);
    const handle = await open(file, 'r+');

    try {
      const keep = await lengthThroughLastNewline({ handle, size });

      if (keep < size) await handle.truncate(keep);

      return size - keep;
    } finally {
      await handle.close();
    }
  } catch (caughtError) {
    if (isMissingPath(caughtError)) return 0;
    throw new StorageFileError({ file, cause: caughtError });
  }
}

/** Refuses a line of `length` bytes when it is over `maxLineChars`; names it, never shows it. */
function assertShortLine(params: {
  length: number;
  maxLineChars: number;
  file: string;
  lineNumber: number;
}): void {
  const { length, maxLineChars, file, lineNumber } = params;

  if (length <= maxLineChars) return;

  throw new StorageFileError({
    file,
    cause: undefined,
    reason: `line ${String(lineNumber)} is longer than ${String(maxLineChars)} bytes (it is not shown: a conversation is private)`,
  });
}

/** One line as a `schema` value; the error names the line and does not show it. */
function parseLine<TSchema extends z.ZodType>(params: {
  text: string;
  schema: TSchema;
  file: string;
  lineNumber: number;
}): z.infer<TSchema> {
  const { text, schema, file, lineNumber } = params;
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch (caughtError) {
    // A SyntaxError's message quotes the text around the fault, and a conversation is private, so
    // it is replaced by a fixed one without the error as `cause`; any other failure is not ours.
    if (!(caughtError instanceof SyntaxError)) throw caughtError;

    throw new StorageFileError({
      file,
      cause: undefined,
      reason: `line ${String(lineNumber)} is not valid JSON (it is not shown: a conversation is private)`,
    });
  }

  const result = validate({ schema, input: json });

  if (!result.success) {
    throw new StorageFileError({
      file,
      cause: undefined,
      reason: `line ${String(lineNumber)} is not what it should be:\n${result.details}`,
    });
  }

  return result.data;
}

/** The byte length of `file` up to and including its last newline: 0 when it has none. */
async function lengthThroughLastNewline(params: {
  handle: Awaited<ReturnType<typeof open>>;
  size: number;
}): Promise<number> {
  const { handle, size } = params;
  const block = Buffer.alloc(Math.min(TAIL_BLOCK_BYTES, Math.max(size, 1)));

  for (let end = size; end > 0; end -= block.length) {
    const start = Math.max(0, end - block.length);
    const { bytesRead } = await handle.read(block, 0, end - start, start);
    const at = block.subarray(0, bytesRead).lastIndexOf(NEWLINE);

    if (at !== -1) return start + at + 1;
  }

  return 0;
}
