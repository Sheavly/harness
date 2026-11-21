// Reads the workspace layout from the workspaces themselves (see `layout.js` for what comes from
// where): which workspace a file belongs to, and what is wrong with the layout. The rules
// (`rules/layout.js`, `rules/imports.js`), the layout check (`scripts/check-layout.mjs`) and the
// scaffold (`scripts/new-workspace.mjs`) all use it, so they can't disagree.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { exportsProblems } from './exports.utils.js';
import { manifestProblems, readSheavlyJson } from './extension-manifest.utils.js';
import { LAUNCHER_ENTRIES, NOT_SOURCE } from './layout.js';
import { workspaceDirs } from './rules/workspace-types.js';

/**
 * The options of the rules that read the layout: tests point them at a temp workspace (`root`)
 * or a layout of their own.
 */
export const LAYOUT_RULE_OPTIONS = {
  type: 'object',
  properties: {
    root: { type: 'string' },
    layout: { type: 'object' },
  },
  additionalProperties: false,
};

export const DOMAINS = ['generic', 'coding', 'tooling'];
const SCOPE = '@sheavly/';
const LAUNCHER_NAME = 'sheavly';
const LAUNCHER_DIR = 'apps/sheavly';
const ENTRY_FIELDS = ['main', 'module', 'browser'];
const toPosix = (file) => file.split(path.sep).join('/');

/** Every workspace on disk (each `workspaces` match): where it is and its manifest. */
export function listWorkspaces(root) {
  return workspaceDirs(root).map((dir) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));

    return {
      dir,
      relative: toPosix(path.relative(root, dir)) || '.',
      name: manifest.name,
      manifest,
    };
  });
}

/**
 * `packages/*` is a package, `extensions/*` an extension (a library of what a run includes, built
 * on packages), `apps/*` (and a root with source) an app.
 */
function kindOf(relative) {
  if (relative.startsWith('packages/')) return 'package';

  return relative.startsWith('extensions/') ? 'extension' : 'app';
}

function workspaceDeps(params) {
  const { deps, names } = params;

  return Object.keys(deps ?? {}).filter((name) => names.has(name));
}

/**
 * The layout, by workspace name, derived from the workspaces at `root`: `kind` from the folder,
 * `dependsOn` and `devDependsOn` from the manifest's dependencies on other workspaces, `domain`,
 * `testOnly`, `transport` and `appOnlyModules` from its `sheavly` field.
 */
export function readLayout(params) {
  const { root } = params;
  const workspaces = listWorkspaces(root);
  const names = new Set(workspaces.map(({ name }) => name));

  return Object.fromEntries(
    workspaces.map(({ relative, name, manifest }) => [
      name,
      {
        dir: relative,
        kind: kindOf(relative),
        domain: manifest.sheavly?.domain,
        testOnly: manifest.sheavly?.testOnly === true,
        // A way into the harness from outside its process (the HTTP server): only an app starts
        // one, so the library always runs in-process without it.
        transport: manifest.sheavly?.transport === true,
        // The one app that may depend on other apps: the product's command line.
        // Read as written, so a value other than `true` is reported instead of ignored.
        launcher: manifest.sheavly?.launcher,
        appOnlyModules:
          manifest.sheavly?.appOnlyModules === undefined ? [] : manifest.sheavly.appOnlyModules,
        dependsOn: workspaceDeps({ deps: manifest.dependencies, names }),
        devDependsOn: workspaceDeps({ deps: manifest.devDependencies, names }),
        // The public surface: its package.json `exports`, by file kind (`./*.types`), its
        // module folders and their files, and the modules its README documents as API.
        exports: manifest.exports,
        // The fields Node falls back to when `exports` is missing, so an app can be held to none.
        entryFields: ENTRY_FIELDS.filter((field) => manifest[field] !== undefined),
        modules: modulesOf(path.join(root, relative)),
        // What a publish ships, and what builds it first.
        files: manifest.files,
        prepack: manifest.scripts?.prepack,
        // The extension manifest on disk, for the checks that tie it to the workspace.
        sheavlyJson: readSheavlyJson(path.join(root, relative)),
        documented: documentedModules(path.join(root, relative)),
      },
    ]),
  );
}

const MODULE_FILE = /^([a-z0-9-]+\.[a-z]+)\.ts$/;

/** A workspace's module folders in `src/` and their source files' subpaths (`tool.utils`). */
function modulesOf(dir) {
  const src = path.join(dir, 'src');

  if (!existsSync(src)) return [];

  return readdirSync(src, { withFileTypes: true })
    .filter((folder) => folder.isDirectory() && folder.name !== '__tests__')
    .map((folder) => ({
      name: folder.name,
      files: readdirSync(path.join(src, folder.name))
        .map((file) => MODULE_FILE.exec(file)?.[1])
        .filter(Boolean),
    }));
}

/**
 * The module folders a workspace's README documents as API: a table row starting with one
 * (`| \`queue/\` |`). Null when it has no README, which the layout check reports by itself.
 */
function documentedModules(dir) {
  const readme = path.join(dir, 'README.md');

  if (!existsSync(readme)) return null;

  return [...readFileSync(readme, 'utf8').matchAll(/^\| `([a-z0-9-]+)\/` +\|/gm)].map(
    (match) => match[1],
  );
}

/** The workspace `file` belongs to: the deepest workspace dir that holds it. */
export function workspaceOfFile(params) {
  const { workspaces, file } = params;

  return workspaces
    .filter(({ dir }) => file === dir || file.startsWith(`${dir}${path.sep}`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/**
 * The workspace a repo-relative, `/`-separated `file` belongs to: the deepest workspace folder
 * that holds it. The root (`.`) holds no file this way; a file outside every workspace is undefined.
 */
export function workspaceOfRelative(params) {
  const { workspaces, file } = params;

  return workspaces
    .filter(({ relative }) => file.startsWith(`${relative}/`))
    .sort((a, b) => b.relative.length - a.relative.length)[0];
}

/** npm's flag for the workspace at `dir`; none for the root, which isn't one of its workspaces. */
export function workspaceFlag(dir) {
  return dir === '.' ? '' : ` -w ${dir}`;
}

/** The command that sets a workspace's domain, for messages that say what to add. */
function domainCommand(dir) {
  return `npm pkg set sheavly.domain=<${DOMAINS.join('|')}>${workspaceFlag(dir)}`;
}

/** Why `name` may not depend on `dependency` at runtime, or null when it may. */
export function edgeProblem(params) {
  const { name, entry, dependency, layout } = params;
  const target = layout[dependency];

  if (!target) return `${name} depends on ${dependency}, which isn't a workspace`;

  if (target.launcher === true) {
    return `${name} depends on ${dependency}, an app: nothing imports an app, the launcher included`;
  }

  // Only the launcher composes apps, and only those it is listed for; every other edge rule below
  // still applies to it.
  if (target.kind === 'app' && entry.launcher !== true) {
    return `${name} depends on ${dependency}, an app: nothing imports an app`;
  }

  if (target.kind === 'app' && !Object.hasOwn(LAUNCHER_ENTRIES, dependency)) {
    return `${name} depends on ${dependency}, an app it doesn't launch: the launcher runs only ${Object.keys(LAUNCHER_ENTRIES).join(', ')}. A new one is a reviewed entry in LAUNCHER_ENTRIES (packages/eslint-config/src/layout.js)`;
  }

  if (target.transport && entry.kind !== 'app') {
    return `${name} depends on ${dependency}, a transport: only an app starts one, so the library runs without it. Depend on what it serves (\`@sheavly/host\`) instead`;
  }

  if (target.kind === 'extension' && entry.kind === 'package') {
    return `${name} depends on ${dependency}, an extension: extensions are built on packages, never the other way round. An app composes extensions`;
  }

  if (entry.domain === 'generic' && target.domain === 'coding') {
    return `${name} is generic but depends on ${dependency}, a coding workspace`;
  }

  if (target.domain === 'tooling' || target.testOnly) {
    return `${name} depends on ${dependency}, which source never imports: make it a dev dependency`;
  }

  return null;
}

/**
 * The launcher is the product's command line, so exactly one workspace sets `sheavly.launcher`:
 * `apps/sheavly`, named `sheavly`. The flag is what lets it depend on apps, so it is never
 * trusted on any other workspace.
 */
function launcherProblems(params) {
  const { name, entry, layout } = params;

  if (entry.launcher === undefined) return [];

  if (entry.launcher !== true) {
    return [`${name} sets sheavly.launcher to something other than true: remove it`];
  }

  const problems = [];
  const launchers = Object.entries(layout).filter(([, other]) => other.launcher === true);

  if (launchers.length > 1) {
    const names = launchers.map(([launcherName]) => launcherName).join(', ');

    problems.push(
      `${name} sets sheavly.launcher, but so do ${names}: exactly one workspace is the launcher`,
    );
  }

  if (entry.dir !== LAUNCHER_DIR) {
    problems.push(
      `${name} sets sheavly.launcher, but only ${LAUNCHER_DIR} is the launcher: \`npm pkg delete sheavly.launcher${workspaceFlag(entry.dir)}\``,
    );
  }

  return problems;
}

function identityProblems(params) {
  const { name, entry, layout } = params;
  const problems = [];

  if (!DOMAINS.includes(entry.domain)) {
    problems.push(`${name} has no domain: run \`${domainCommand(entry.dir)}\``);
  }

  const folder = path.posix.basename(entry.dir);

  if (entry.launcher === true) {
    if (name !== LAUNCHER_NAME) {
      problems.push(`${name} is the launcher, so it must be named ${LAUNCHER_NAME}, not ${name}`);
    }
  } else if (name === LAUNCHER_NAME) {
    problems.push(
      `${name} is the launcher's name, but it doesn't set sheavly.launcher: only the launcher is named ${LAUNCHER_NAME}`,
    );
  } else if (entry.dir !== '.' && name !== `${SCOPE}${folder}`) {
    // A root with source has no folder of its own to be named after.
    problems.push(`${name} must be named ${SCOPE}${folder}, after its folder`);
  }

  return [...problems, ...launcherProblems({ name, entry, layout })];
}

function appOnlyModuleProblems(params) {
  const { name, entry } = params;
  const modules = entry.appOnlyModules === undefined ? [] : entry.appOnlyModules;

  if (!Array.isArray(modules)) {
    return [`${name} sheavly.appOnlyModules must be an array of module folder names`];
  }

  const folders = new Set((entry.modules ?? []).map((module) => module.name));
  const seen = new Set();

  return modules.flatMap((module) => {
    if (typeof module !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(module)) {
      return [`${name} sheavly.appOnlyModules must name direct kebab-case src module folders`];
    }

    if (seen.has(module)) {
      return [`${name} sheavly.appOnlyModules repeats ${module}: list each module once`];
    }

    seen.add(module);

    return folders.has(module)
      ? []
      : [`${name} sheavly.appOnlyModules names ${module}, which is not a src module folder`];
  });
}

/** What is wrong with one workspace's entry: its domain, its name, its edges and its manifest. */
export function entryProblems(params) {
  const { name, entry, layout } = params;
  // A test may use any workspace below it (a real tool to drive the loop with), but never an
  // app, and a generic workspace's tests never a coding one: they must run without a project.
  const devProblems = entry.devDependsOn.flatMap((dependency) => {
    const target = layout[dependency];

    if (target?.kind === 'app') {
      return [`${name} has ${dependency} as a dev dependency, an app: nothing imports an app`];
    }

    if (target?.transport && entry.kind !== 'app') {
      return [
        `${name} has ${dependency} as a dev dependency, a transport: test what it serves in-process instead`,
      ];
    }

    if (entry.domain === 'generic' && target?.domain === 'coding') {
      return [
        `${name} is generic but its tests depend on ${dependency}, a coding workspace: they must run without a project`,
      ];
    }

    return [];
  });

  return [
    ...identityProblems({ name, entry, layout }),
    ...appOnlyModuleProblems({ name, entry }),
    ...entry.dependsOn.map((dependency) => edgeProblem({ name, entry, dependency, layout })),
    ...devProblems,
    ...exportsProblems({ name, entry, layout }),
    ...manifestProblems({ name, entry, layout }),
  ].filter(Boolean);
}

/** What is wrong with `layout`: each workspace's domain, name and graph. */
export function layoutProblems(layout) {
  return Object.entries(layout).flatMap(([name, entry]) => entryProblems({ name, entry, layout }));
}

const TYPESCRIPT = /\.[cm]?tsx?$/;

/** What to do about TypeScript outside every workspace's `src/`. */
export const STRAY_SOURCE =
  "source lives in a workspace's src/. Move it, or list why it isn't source in NOT_SOURCE (packages/eslint-config/src/layout.js).";

/**
 * `file` matches `glob`. A trailing `/**` takes everything below, dot folders included
 * (`path.matchesGlob` skips those, and a fixture's `.sheavly/` is still not harness source).
 */
function matchesPath(params) {
  const { file, glob } = params;

  return glob.endsWith('/**') ? file.startsWith(glob.slice(0, -2)) : path.matchesGlob(file, glob);
}

/**
 * True when `file` (`/`-separated, from the root) is TypeScript outside every workspace's `src/`
 * and `notSource` doesn't say why it may be.
 */
export function isStraySource(params) {
  const { workspaces, file, notSource = NOT_SOURCE } = params;
  const sources = workspaces.map(({ relative }) =>
    relative === '.' ? 'src/' : `${relative}/src/`,
  );

  return (
    TYPESCRIPT.test(file) &&
    !sources.some((src) => file.startsWith(src)) &&
    !Object.keys(notSource).some((glob) => matchesPath({ file, glob }))
  );
}
