// The log event catalogue, read from the workspaces: every `*.constants.ts` that exports a
// `LOG_EVENT` (name -> event) and its `LOG_EVENT_MEANING` (name -> a sentence). Nothing is listed
// by hand: a workspace that starts logging is covered by having the constants. `logEventProblems`
// is what the catalogue suite asserts is empty, and the suite checks it rejects each fault.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isTestOrFake } from './test-paths.utils.js';

const CONSTANTS_FILE = /\.constants\.ts$/;
/** Lowercase `<area>.<what_happened>`, each part words joined by underscores. */
const EVENT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const MIN_MEANING_WORDS = 6;

/** The text between `export const <name> = {` and its closing brace, or undefined. */
function objectBody(params) {
  const { text, name } = params;

  return new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1];
}

/** `KEY: 'text'` pairs of an object body, the text possibly on the line after the key. */
function stringEntries(body) {
  const entries = new Map();

  for (const [, key, value] of body.matchAll(/([A-Z][A-Z0-9_]*):\s*'((?:[^'\\]|\\.)*)'/g)) {
    entries.set(key, value.replaceAll(/\\(.)/g, '$1'));
  }

  return entries;
}

/** The catalogue of one constants file, or undefined when it holds no `LOG_EVENT`. */
export function readCatalogue(params) {
  const { text, file } = params;
  const events = objectBody({ text, name: 'LOG_EVENT' });

  if (events === undefined) return undefined;

  const meanings = objectBody({ text, name: 'LOG_EVENT_MEANING' });

  return {
    file,
    events: stringEntries(events),
    meanings: meanings === undefined ? new Map() : stringEntries(meanings),
  };
}

function sourceFiles(src) {
  return readdirSync(src, { recursive: true })
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => entry.endsWith('.ts') && !isTestOrFake(entry))
    .map((entry) => path.join(src, entry));
}

/**
 * Every catalogue of the workspaces at `dirs`, each with the source of its workspace (what could
 * use its events): `{ file, events, meanings, workspace, sources }` where `sources` maps each
 * other source file of the workspace to its text.
 */
export function readCatalogues(dirs) {
  return dirs.flatMap((dir) => {
    const src = path.join(dir, 'src');
    let files;

    try {
      files = sourceFiles(src);
    } catch (caughtError) {
      // A workspace with no `src/` (the monorepo root) has no catalogue; anything else is real.
      if (caughtError.code === 'ENOENT') return [];

      throw caughtError;
    }

    const texts = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));

    return files
      .filter((file) => CONSTANTS_FILE.test(file))
      .flatMap((file) => {
        const catalogue = readCatalogue({ text: texts.get(file), file });

        if (!catalogue) return [];

        const sources = new Map([...texts].filter(([other]) => other !== file));

        return [{ ...catalogue, workspace: dir, sources }];
      });
  });
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/** What is wrong with one catalogue, as sentences naming the event and the file. */
function catalogueProblems(catalogue) {
  const { file, events, meanings, sources } = catalogue;
  const problems = [];
  const used = (key) =>
    [...sources.values()].some((text) => new RegExp(`LOG_EVENT\\.${key}\\b`).test(text));

  for (const [key, value] of events) {
    if (!EVENT_NAME.test(value)) {
      problems.push(`${file}: ${key} is '${value}', not a lowercase dotted <area>.<what_happened>`);
    }

    const meaning = meanings.get(key);

    if (meaning === undefined) {
      problems.push(`${file}: ${key} has no LOG_EVENT_MEANING`);
    } else if (wordCount(meaning) < MIN_MEANING_WORDS || !/[.!?]$/.test(meaning.trim())) {
      problems.push(
        `${file}: the meaning of ${key} is not a sentence (${String(MIN_MEANING_WORDS)} words or more, ending in a full stop)`,
      );
    }

    if (!used(key)) {
      problems.push(`${file}: ${key} is never used as LOG_EVENT.${key} in its workspace`);
    }
  }

  for (const key of meanings.keys()) {
    if (!events.has(key)) {
      problems.push(`${file}: LOG_EVENT_MEANING has ${key}, which LOG_EVENT does not`);
    }
  }

  return problems;
}

/** What is wrong across `catalogues`: each one's problems, and an event value used twice. */
export function logEventProblems(catalogues) {
  const owners = new Map();
  const problems = catalogues.flatMap(catalogueProblems);

  for (const { file, events } of catalogues) {
    for (const value of events.values()) owners.set(value, [...(owners.get(value) ?? []), file]);
  }

  for (const [value, files] of owners) {
    if (files.length > 1) {
      problems.push(`'${value}' is an event of more than one entry: ${files.join(', ')}`);
    }
  }

  return problems;
}
