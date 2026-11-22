// A package's public API, read from its package.json `exports` and checked against its source and
// its README. Every package is treated as published: `exports` is its semver contract.
//
// - A file kind is public by pattern: `"./*.types": { "@sheavly/source": "./src/*.types.ts",
//   "default": "./dist/*.types.js" }`, so a new module of that kind needs no entry.
// - A module folder that holds files of a public kind but isn't API is closed:
//   `"./queue/*": null`. Node and TypeScript pick the longest matching key, so it wins.
// - Its fakes are `./testing/*`, from source only, for other workspaces' tests.
// - The public modules are the ones its README's API table has a row for (`| \`queue/\` |`), so
//   what is public is what is documented; a module in only one of them fails.
// - It ships what `exports` points at: `files` holds `dist` and `docs`, never `src`, and
//   `prepack` builds it.
import { extensionsOf, FILE_KINDS } from './file-kinds.js';
import { LAUNCHER_ENTRIES } from './layout.js';

const TESTING_EXPORT = './testing/*';
const TESTING_TARGET = { '@sheavly/source': './src/testing/*.ts' };

/** The `exports` key that makes every file of `kind` public: `./*.types`. */
export const kindExportKey = (kind) => `./*.${kind}`;

/** What a kind's `exports` entry points at: the source for dev and tests, the build for Node. */
export function kindExportTarget(kind) {
  return { '@sheavly/source': `./src/*.${kind}.ts`, default: `./dist/*.${kind}.js` };
}

/** The `exports` key that closes a module folder: `./queue/*`. */
const closedKey = (module) => `./${module}/*`;

/** The part of `key` before its `*`, when `key` matches `subpath`; undefined when it doesn't. */
function matchedPrefix(params) {
  const { key, subpath } = params;
  const [prefix = '', suffix] = key.split('*');
  const target = `./${subpath}`;

  if (suffix === undefined) return key === target ? key : undefined;

  return target.startsWith(prefix) && target.endsWith(suffix) ? prefix : undefined;
}

/**
 * Whether `subpath` (`tool/tool.utils`) is public, resolved as Node resolves it: the matching key
 * with the longest prefix wins, and a `null` there closes it.
 */
export function isExported(params) {
  const { exports, subpath } = params;

  if (!exports || typeof exports !== 'object') return false;

  const [best] = Object.keys(exports)
    .map((key) => ({ key, prefix: matchedPrefix({ key, subpath }) }))
    .filter(({ prefix }) => prefix !== undefined)
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return best !== undefined && exports[best.key] !== null;
}

/** The command that exports every file of `kind` from the package at `dir`. */
function exportCommand(params) {
  const { dir, kind } = params;

  return `npm run export -- ${dir} ${kind}`;
}

/** The command that closes `module` in the package at `dir`. */
function closeCommand(params) {
  const { dir, module } = params;

  return `npm pkg set 'exports[${closedKey(module)}]=null' --json -w ${dir}`;
}

function kindEntryProblem(params) {
  const { name, entry, key, target } = params;
  const kind = /^\.\/\*\.([a-z]+)$/.exec(key)?.[1];
  // A package exports plain `.ts` kinds: a React view (`component`) belongs to an app.
  const known =
    kind && FILE_KINDS.includes(kind) && kind !== 'test' && extensionsOf(kind).join() === 'ts';

  if (!known) {
    const fileKind = /\.([a-z]+)$/.exec(key)?.[1] ?? '<kind>';

    return `${name} exports ${key}: a package exports by file kind, never file by file, so a new module needs no entry. Export the kind instead: \`${exportCommand({ dir: entry.dir, kind: fileKind })}\` (\`${kindExportKey(fileKind)}\`), and close the modules that aren't API with \`./<module>/*\`: null`;
  }

  if (kind === 'fake' && !entry.testOnly) {
    return `${name} exports its fakes as a kind: put them in src/testing/ and export ${TESTING_EXPORT}`;
  }

  return JSON.stringify(target) === JSON.stringify(kindExportTarget(kind))
    ? null
    : `${name} exports ${key} with other targets: make it ${JSON.stringify(kindExportTarget(kind))}`;
}

/** What is wrong with one `exports` entry of a package; null when it is fine. */
function exportEntryProblem(params) {
  const { name, entry, key, target } = params;

  if (key === TESTING_EXPORT) {
    return JSON.stringify(target) === JSON.stringify(TESTING_TARGET)
      ? null
      : `${name} exports ${key}, its fakes, but not from source only: make it ${JSON.stringify(TESTING_TARGET)}`;
  }

  if (target === null) {
    const module = /^\.\/([a-z][a-z0-9-]*)\/\*$/.exec(key)?.[1];

    if (!module) return `${name} closes ${key}: close a module folder, as \`./<module>/*\`: null`;

    return entry.modules?.some((found) => found.name === module)
      ? null
      : `${name} closes ${key}, but it has no module ${module}/: remove the entry`;
  }

  return kindEntryProblem({ name, entry, key, target });
}

/** The modules of `entry` that `exports` makes reachable: a file of a public kind, not closed. */
function publicModules(entry) {
  return (entry.modules ?? [])
    .filter(({ name }) => name !== 'testing')
    .filter(({ name, files }) =>
      files.some((file) => isExported({ exports: entry.exports, subpath: `${name}/${file}` })),
    )
    .map(({ name }) => name);
}

/**
 * The public modules and the README's API table agree: each module `exports` opens has a row,
 * and each row is a module it opens. Fakes (`testing/`) are documented, not counted.
 */
function apiProblems(params) {
  const { name, entry } = params;

  if (!entry.documented) return [];

  const open = publicModules(entry);
  const rows = entry.documented.filter((module) => module !== 'testing');
  const undocumented = open
    .filter((module) => !rows.includes(module))
    .map(
      (module) =>
        `${name}'s ${module}/ is public (its exports open it) but its README's API table has no row for it. If it is API, add \`| \`${module}/\` | … |\`; if not, close it: \`${closeCommand({ dir: entry.dir, module })}\``,
    );
  const notPublic = rows
    .filter((module) => !open.includes(module))
    .map(
      (module) =>
        `${name}'s README lists ${module}/ as API, but its exports don't open it: export its file kind (\`${exportCommand({ dir: entry.dir, kind: '<kind>' })}\`) or move the row to "Internal"`,
    );

  return [...undocumented, ...notPublic];
}

/** What a published package ships besides its README: the build and the docs, never the source. */
const PUBLISHED_FILES = ['dist', 'docs'];
const PREPACK = 'npm run build';
const SOURCE_FILE = /^(\.\/)?src(\/|$)/;

/**
 * What stops a package from being published as its `exports` promise: it must ship its build
 * (`dist/`) and its docs, never its source or tests, and build before it packs. Tooling and
 * test-only packages aren't published.
 */
function publishProblems(params) {
  const { name, entry } = params;

  if (entry.kind === 'app' || entry.domain === 'tooling' || entry.testOnly) return [];

  const files = Array.isArray(entry.files) ? entry.files : [];
  const missing = PUBLISHED_FILES.filter((file) => !files.includes(file));
  const kept = files.filter((file) => !PUBLISHED_FILES.includes(file) && !SOURCE_FILE.test(file));
  const problems = [];

  if (missing.length > 0 || files.some((file) => SOURCE_FILE.test(file))) {
    problems.push(
      `${name} would publish ${files.length === 0 ? 'everything, its source and tests included' : JSON.stringify(files)}: ship its build and docs only, \`npm pkg set 'files=${JSON.stringify([...PUBLISHED_FILES, ...kept])}' --json -w ${entry.dir}\``,
    );
  }

  if (entry.prepack !== PREPACK) {
    problems.push(
      `${name} doesn't build before it packs, so a publish could ship a stale or missing dist/: \`npm pkg set scripts.prepack="${PREPACK}" -w ${entry.dir}\``,
    );
  }

  return problems;
}

/** What is wrong with one `exports` entry of an app the launcher runs; null when it is fine. */
function appExportProblem(params) {
  const { name, entry, key, target } = params;
  const subpath = /^\.\/([a-z0-9-]+\/[a-z0-9-]+\.[a-z]+)$/.exec(key)?.[1];
  const [module, file] = subpath?.split('/') ?? [];
  const exists = entry.modules?.some(
    (found) => found.name === module && found.files.includes(file),
  );

  if (!exists) {
    return `${name} exports ${key}: an app exports the entry files of its modules, as \`./<module>/<file>.<kind>\``;
  }

  // Existing is not enough: the launcher takes only what was reviewed, so an app can't hand it
  // something like its backend spawn by exporting it.
  const listed = Object.hasOwn(LAUNCHER_ENTRIES, name) ? LAUNCHER_ENTRIES[name] : [];

  if (!listed.includes(subpath)) {
    return `${name} exports ${key}, which the launcher isn't listed to import: an app exports only its entries in LAUNCHER_ENTRIES (packages/eslint-config/src/layout.js), a reviewed edit. Remove it, or add it there if the launcher runs it`;
  }

  // A fake is not built (its folder is out of the build): it is exported from source only.
  const expected =
    module === 'testing'
      ? { '@sheavly/source': `./src/${subpath}.ts` }
      : { '@sheavly/source': `./src/${subpath}.ts`, default: `./dist/${subpath}.js` };

  return JSON.stringify(target) === JSON.stringify(expected)
    ? null
    : `${name} exports ${key} with other targets: make it ${JSON.stringify(expected)}`;
}

/**
 * What is wrong with an app's `exports`. Only the launcher imports an app, so an app exports
 * nothing unless the launcher depends on it, and then only the entry files it runs, one by one
 * and listed in `LAUNCHER_ENTRIES` (`./run/run.helper`): an app has no public kinds to open.
 */
function appExportsProblems(params) {
  const { name, entry, layout } = params;
  const { exports } = entry;
  // Node reads these when `exports` is missing, which would open any file past the list.
  const entryFieldProblems = (entry.entryFields ?? []).map(
    (field) =>
      `${name} sets \`${field}\`: an app is reached only through the entries LAUNCHER_ENTRIES lists in its \`exports\`. Remove it: \`npm pkg delete ${field} -w ${entry.dir}\``,
  );

  if (entryFieldProblems.length > 0) return entryFieldProblems;

  const launcherUsesIt = Object.values(layout ?? {}).some(
    (other) => other.launcher === true && other.dependsOn.includes(name),
  );

  if (!launcherUsesIt) {
    return exports
      ? [`${name} has exports, but nothing imports an app but the launcher: remove them`]
      : [];
  }

  // Without an `exports` map Node resolves every file of the app, so the list would hold nothing.
  if (!exports || typeof exports !== 'object' || Array.isArray(exports)) {
    return [
      `${name} is run by the launcher but has no \`exports\` map: without one Node opens every file of it. Export each of its LAUNCHER_ENTRIES (packages/eslint-config/src/layout.js), as \`./<module>/<file>.<kind>\``,
    ];
  }

  return Object.entries(exports)
    .map(([key, target]) => appExportProblem({ name, entry, key, target }))
    .filter(Boolean);
}

/**
 * What is wrong with a workspace's public API. A package declares it by file kind, closes the
 * module folders that aren't API, and documents every one that is. An app exports nothing, except
 * the entry files the launcher imports.
 */
export function exportsProblems(params) {
  const { name, entry, layout } = params;
  const { exports } = entry;

  if (entry.kind === 'app') return appExportsProblems({ name, entry, layout });

  if (entry.domain === 'tooling') return [];

  if (!exports || typeof exports !== 'object') {
    return [
      `${name} has no exports, so every file is public. Export the kinds other workspaces import: \`${exportCommand({ dir: entry.dir, kind: 'types' })}\` (or \`npm pkg set exports={} --json\` while it has none)`,
    ];
  }

  return [
    ...Object.entries(exports)
      .map(([key, target]) => exportEntryProblem({ name, entry, key, target }))
      .filter(Boolean),
    ...apiProblems({ name, entry }),
    ...publishProblems({ name, entry }),
  ];
}
