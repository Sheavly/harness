// The workspace scaffold: `npm run new -- <package|extension|app> <name> --domain <d> --description "…"
// [--depends-on a,b]` creates a workspace the layout accepts as it is (see the README's
// "Workspace layout"). Nothing central is edited: the workspace is created, and the layout reads
// it. The graph is checked first, against the workspaces on disk, so a dependency it doesn't allow
// is refused before anything changes. An allowed dependency is installed with its first import
// (the scaffold prints the command): installed earlier, nothing would import it, and knip fails.
//
//   package   packages/<name>, imported by the file kinds its `exports` makes public
//             (`@sheavly/<name>/<module>/<module>.<kind>`, added with `npm run export`)
//   extension extensions/<name>, a library of what a run includes (tools, hooks), built on
//             packages and composed by an app; its API is declared like a package's, and it
//             declares itself in a `sheavly.json` (listed in `files`) that its first
//             `defineExtension({ manifest: readManifest(new URL('../../sheavly.json', import.meta.url)), … })`
//             reads. The scaffold writes the file; the first module is the author's.
//   app       apps/<name>, a front end or host; nothing imports it
//
// package.json is only ever written through npm (`npm init -w`, `npm pkg set`, `npm install`).
// The configs, a README and a first doc in docs/ are written as files. No code or test is: the first module is the
// author's, and until it lands the layout check says the workspace has no source.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { format, resolveConfig } from 'prettier';
import {
  DOMAINS,
  edgeProblem,
  readLayout,
  workspaceFlag,
} from '../packages/eslint-config/src/layout.utils.js';

const SCOPE = '@sheavly/';
const FOLDERS = { package: 'packages', extension: 'extensions', app: 'apps' };
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What would be created, or the problems that stop it. Reads the repo; changes nothing. */
export function planWorkspace(params) {
  const { root, kind, name, domain, description, dependsOn = [] } = params;
  const problems = [];

  if (!(kind in FOLDERS)) {
    problems.push(`the kind is \`package\`, \`extension\` or \`app\`, not \`${kind}\``);
  }

  if (!KEBAB.test(name ?? '')) {
    problems.push(`the name is kebab-case (\`road-segments\`), not \`${name}\``);
  }

  if (!DOMAINS.includes(domain)) problems.push(`--domain is one of ${DOMAINS.join(', ')}`);

  if (!description?.trim()) {
    problems.push('--description says what the workspace is for, in one line');
  }

  if (problems.length > 0) return { problems };

  const dir = `${FOLDERS[kind]}/${name}`;
  const fullName = `${SCOPE}${name}`;
  const layout = readLayout({ root });

  if (existsSync(path.join(root, dir)) || fullName in layout) {
    return { problems: [`${dir} (${fullName}) already exists`] };
  }

  const entry = {
    dir,
    kind,
    domain,
    testOnly: false,
    dependsOn: dependsOn.map((dep) => (dep.startsWith(SCOPE) ? dep : `${SCOPE}${dep}`)),
    devDependsOn: [],
  };
  // Checked against the workspaces as they are, so naming itself reads as "isn't a workspace".
  const edges = entry.dependsOn
    .map((dependency) => edgeProblem({ name: fullName, entry, dependency, layout }))
    .filter(Boolean);

  if (edges.length > 0) return { problems: edges };

  // The version each dependency has now, which its install names: a pinned `@0.0.0` would stop
  // matching the day one of them moves.
  const versions = Object.fromEntries(
    entry.dependsOn.map((dep) => [
      dep,
      JSON.parse(readFileSync(path.join(root, layout[dep].dir, 'package.json'), 'utf8')).version,
    ]),
  );

  return { problems: [], dir, fullName, entry, versions, description: description.trim() };
}

/**
 * Every workspace starts on the shared config alone. An app is a front end because of where it is
 * (`apps/`): the shared config gives it terminal I/O, printing and env, and a package none of them.
 */
const ESLINT_CONFIG =
  "import { baseConfig } from '@sheavly/eslint-config';\n\nexport default baseConfig({ tsconfigRootDir: import.meta.dirname });\n";

const TSCONFIG = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    // Dev, tests and typecheck read the .ts source (the \`@sheavly/source\` export condition);
    // \`tsconfig.build.json\` compiles it to \`outDir\` for plain Node.
    // \`rootDir\` makes an import from outside the workspace a type error.
    "rootDir": "src",
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src"]
}
`;

function tsconfigBuild(params) {
  const { layout, entry } = params;
  const references = entry.dependsOn.map((dep) => ({
    path: `${path.posix.relative(entry.dir, layout[dep].dir)}/tsconfig.build.json`,
  }));

  return `${JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: false,
        composite: true,
        outDir: 'dist',
        tsBuildInfoFile: 'dist/tsconfig.build.tsbuildinfo',
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        customConditions: [],
      },
      ...(references.length > 0 ? { references } : {}),
      exclude: ['src/**/__tests__', 'src/testing'],
    },
    null,
    2,
  )}\n`;
}

/**
 * The README: the first place someone looks. What it is for, then (once it has code) its public
 * API with an example, and a link to each doc in docs/, which goes deeper.
 */
function readme(params) {
  const { fullName, description } = params;

  return `# ${fullName}

${description}

## Docs

- [Design](docs/design.md): how it works, and how to extend it.
`;
}

/** The first doc in docs/: a place for what goes beyond the README, for the author to write. */
const DESIGN_DOC = `# Design

How this workspace works inside, why it is built this way, and how to extend it. Keep the README
to what it is for, its public API and an example; what goes deeper goes here, one topic per file,
each linked from the README.
`;

/** What a published workspace ships: its build and docs, and an extension its manifest too. */
function publishedFiles(kind) {
  return kind === 'extension' ? ['dist', 'docs', 'sheavly.json'] : ['dist', 'docs'];
}

/**
 * An extension's manifest, as small as it can be: its name and no dependencies. The layout check
 * asks for `dependsOn` once the package depends on another extension, and `readManifest` reads
 * the rest (services, settings, tools) as the extension grows.
 */
function extensionManifest(params) {
  const { dir, name } = params;
  const schema = path.posix.relative(dir, 'packages/extension/sheavly.schema.json');

  return `${JSON.stringify({ $schema: schema, name: name.slice(SCOPE.length), dependsOn: [] }, null, 2)}\n`;
}

/** Every step that creates the workspace, in order: commands for npm, files for the rest. */
function steps(params) {
  const { plan, root } = params;
  const { dir, fullName, entry, description } = plan;
  const workspaces = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces;
  const pattern = `${FOLDERS[entry.kind]}/*`;
  const set = (...fields) => ['pkg', 'set', ...fields, '-w', dir];
  const scripts = [
    'scripts.typecheck=tsc --noEmit',
    'scripts.build=tsc -b tsconfig.build.json',
    'scripts.lint=eslint .',
    'scripts.test=vitest run --config ../../vitest.config.ts',
  ];

  return [
    ...(workspaces.includes(pattern)
      ? []
      : [{ npm: ['pkg', 'set', `workspaces[${workspaces.length}]=${pattern}`] }]),
    { npm: ['init', '-y', '-w', dir] },
    { npm: ['pkg', 'delete', 'main', 'keywords', 'author', 'scripts.test', '-w', dir] },
    {
      npm: set(
        `name=${fullName}`,
        'version=0.0.0',
        `description=${description}`,
        'type=module',
        'license=Apache-2.0',
        `sheavly.domain=${entry.domain}`,
        ...scripts,
      ),
    },
    { npm: ['pkg', 'set', 'private=true', '--json', '-w', dir] },
    // A package's public API starts empty: each file kind other workspaces import is made public
    // with `npm run export`, so nothing is public by accident. An app exports nothing.
    ...(entry.kind === 'app' ? [] : [{ npm: ['pkg', 'set', 'exports={}', '--json', '-w', dir] }]),
    // A package or extension is published: it ships its build and docs, never its source, built first.
    ...(entry.kind === 'app' || entry.domain === 'tooling'
      ? []
      : [
          {
            npm: [
              'pkg',
              'set',
              `files=${JSON.stringify(publishedFiles(entry.kind))}`,
              '--json',
              '-w',
              dir,
            ],
          },
          { npm: ['pkg', 'set', 'scripts.prepack=npm run build', '-w', dir] },
        ]),
    // `npm init -w` registered it under its folder name; `npm pkg` renamed it without touching the
    // lockfile or the node_modules link. Reify once, so both know it as `@sheavly/<name>`.
    { npm: ['install', '--no-audit', '--no-fund'] },
    { file: `${dir}/eslint.config.js`, content: ESLINT_CONFIG },
    { file: `${dir}/tsconfig.json`, content: TSCONFIG },
    { file: `${dir}/tsconfig.build.json`, content: tsconfigBuild({ layout: plan.layout, entry }) },
    ...(entry.kind === 'extension'
      ? [{ file: `${dir}/sheavly.json`, content: extensionManifest({ dir, name: fullName }) }]
      : []),
    { file: `${dir}/README.md`, content: readme({ fullName, description }) },
    { file: `${dir}/docs/design.md`, content: DESIGN_DOC },
  ];
}

/**
 * The installs `plan`'s dependencies need. Run each with the first import of that dependency: a
 * dependency nothing imports yet fails knip, and `harness/imports` names the same command.
 */
export function installCommands(plan) {
  return plan.entry.dependsOn.map(
    (dep) => `npm install ${dep}@${plan.versions[dep]}${workspaceFlag(plan.dir)}`,
  );
}

function runNpm(params) {
  const { root, args } = params;
  const result = spawnSync('npm', args, { cwd: root, encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  }
}

/** Writes `content` to `file`, formatted the way the repo's Prettier config says. */
async function writeFormatted(params) {
  const { root, file, content } = params;
  const target = path.join(root, file);
  const options = await resolveConfig(target);

  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, await format(content, { ...options, filepath: target }));
}

/** Creates the workspace `plan` describes; `npm` runs each npm command (real npm by default). */
export async function createWorkspace(params) {
  const { root, plan, npm = (args) => runNpm({ root, args }) } = params;

  for (const step of steps({ plan: { ...plan, layout: readLayout({ root }) }, root })) {
    if (step.npm) npm(step.npm);
    else await writeFormatted({ root, file: step.file, content: step.content });
  }
}

function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      domain: { type: 'string' },
      description: { type: 'string' },
      'depends-on': { type: 'string' },
    },
  });
  const [kind, name] = positionals;
  const dependsOn = (values['depends-on'] ?? '')
    .split(',')
    .map((dep) => dep.trim())
    .filter(Boolean);

  return { kind, name, domain: values.domain, description: values.description, dependsOn };
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '..');
  const plan = planWorkspace({ root, ...parseCli(process.argv.slice(2)) });

  if (plan.problems.length > 0) {
    console.error(`Not created:\n${plan.problems.map((problem) => `- ${problem}`).join('\n')}`);
    console.error(
      '\nUsage: npm run new -- <package|extension|app> <name> --domain <generic|coding|tooling> --description "…" [--depends-on a,b]',
    );
    process.exit(1);
  }

  await createWorkspace({ root, plan });
  console.log(
    `Created ${plan.dir} (${plan.fullName}). Next: its first module, ${plan.dir}/src/<module>/<module>.<kind>.ts, with its tests in <module>/__tests__/.`,
  );

  for (const command of installCommands(plan)) {
    console.log(`With its first import of it: ${command}`);
  }
}
