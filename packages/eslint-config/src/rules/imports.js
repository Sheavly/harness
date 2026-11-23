// Imports follow the workspace layout, read from the workspaces (`layout.utils.js`). In every
// workspace, tests included:
//
// - another workspace only if this one's package.json depends on it (its `devDependencies` count
//   for tests and fakes); a test-only workspace only from tests and fakes;
// - no relative import that leaves the importing workspace (`../../packages/core/...`): import
//   another workspace by its package name;
// - a package (or the app the launcher runs) only through its public API, the subpaths its
//   package.json `exports` lists (plus `./testing/*`, its fakes, from tests only);
// - in a package's source, no other workspace's `*.tool` module, unless it is a tool itself:
//   which tools a run includes is the UI's choice, so only apps (and tests) put tools together;
// - modules marked by `sheavly.appOnlyModules` are app-selected: package value imports are
//   rejected, except within that same marked module. Tests, fakes and erased types are allowed.
import path from 'node:path';
import { isExported } from '../exports.utils.js';
import {
  LAYOUT_RULE_OPTIONS,
  listWorkspaces,
  readLayout,
  workspaceFlag,
  workspaceOfFile,
} from '../layout.utils.js';
import { isTestOrFake } from '../test-paths.utils.js';
import { isTypeOnly, specifierVisitors } from './import-node.utils.js';
import { findRoot } from './workspace-types.js';

function toPosix(file) {
  return file.split(path.sep).join('/');
}

export const importsRule = {
  meta: {
    type: 'problem',
    schema: [LAYOUT_RULE_OPTIONS],
    messages: {
      notInGraph: `{{from}} may not import {{target}}: {{from}}'s package.json doesn't depend on it. {{why}}`,
      testOnly: `{{target}} is for tests and fakes only; source never imports it.`,
      appOnlyModule: `{{target}}/{{module}} is marked app-only in sheavly.appOnlyModules: package source cannot select it. Take its contract as an option and let the app inject the implementation. Only the marked module itself may import its internal helpers.`,
      crossesWorkspace: `This relative import leaves {{from}} for {{target}}. Import it by package name (\`@sheavly/...\`), and depend on it in package.json.`,
      notExported: `{{specifier}} isn't part of {{target}}'s public API: its package.json \`exports\` doesn't export that file's kind. Import what it exports, or, if every file of that kind should be public, add the kind in review (\`npm run export -- <dir> <kind>\`).`,
      appRoot: `{{specifier}} is an app's bare name: an app exports only the entry files the launcher runs (LAUNCHER_ENTRIES in packages/eslint-config/src/layout.js), never itself. Import the entry file by its subpath.`,
      fakeInSource: `{{specifier}} is a fake ({{target}}'s \`testing/\`): only tests and other fakes import it.`,
      composesRun: `{{from}} may not include {{target}}'s tool in a run: which tools a run gets is the UI's choice. Export what the tool needs (its services, its options) and let the app add it.`,
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const root = options.root ?? findRoot(context.cwd);
    const layout = options.layout ?? (root && readLayout({ root }));

    if (!root) return {}; // harness/layout reports the missing root

    const workspaces = listWorkspaces(root);
    const file = context.filename;
    const from = workspaceOfFile({ workspaces, file });
    const entry = from && layout[from.name];

    if (!entry) return {}; // a file outside every workspace: the layout check reports it

    const isTestCode = isTestOrFake(toPosix(path.relative(from.dir, file)));

    const whyNot = (target) => {
      const targetEntry = layout[target];

      if (targetEntry?.kind === 'app') return 'Nothing imports an app.';

      if (entry.domain === 'generic' && targetEntry?.domain === 'coding') {
        return 'A generic workspace never imports a coding one.';
      }

      // The version the target has now: a pinned `@0.0.0` would stop matching it the day it moves.
      const version = workspaces.find(({ name }) => name === target)?.manifest.version;
      const spec = version === undefined ? target : `${target}@${version}`;

      return `If the dependency is real, add it: \`npm install ${spec}${workspaceFlag(entry.dir)}\` (a dev dependency for tests).`;
    };

    const checkAppOnlyModule = (params) => {
      const { node, target, subpath } = params;

      if (isTestCode || entry.testOnly || entry.kind === 'app' || isTypeOnly(node)) {
        return false;
      }

      const module = path.posix.normalize(subpath).split('/')[0];
      const marked = layout[target].appOnlyModules;

      if (!Array.isArray(marked) || !marked.includes(module)) return false;

      const ownModule = toPosix(path.relative(path.join(from.dir, 'src'), file)).split('/')[0];

      if (target === from.name && module === ownModule) return false;

      context.report({ node, messageId: 'appOnlyModule', data: { target, module } });

      return true;
    };

    const checkPackage = (node, specifier) => {
      const target = Object.keys(layout).find(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      );

      if (!target) return;
      if (checkAppOnlyModule({ node, target, subpath: specifier.slice(target.length + 1) })) return;
      if (target === from.name) return;

      if (layout[target].testOnly && !isTestCode) {
        context.report({ node, messageId: 'testOnly', data: { target } });

        return;
      }

      const allowed = isTestCode
        ? [...entry.dependsOn, ...(entry.devDependsOn ?? [])]
        : entry.dependsOn;

      if (!allowed.includes(target)) {
        context.report({
          node,
          messageId: 'notInGraph',
          data: { from: from.name, target, why: whyNot(target) },
        });

        return;
      }

      checkSurface({ node, specifier, target });
    };

    // A tool module imported from a package's own source, other than by another tool, means the
    // package is choosing which tools a run gets.
    const composesRun = () => !isTestCode && entry.kind === 'package' && !file.endsWith('.tool.ts');

    // A package is imported only through what its `exports` list, and its fakes only from tests.
    const checkSurface = (params) => {
      const { node, specifier, target } = params;
      const subpath = specifier.slice(target.length + 1);

      // An app has no root entry: without this, an app with no `exports` (and a `main`) would hand
      // the launcher any file it holds through its bare name.
      if (!subpath) {
        if (layout[target].kind === 'app') {
          context.report({ node, messageId: 'appRoot', data: { specifier } });
        }

        return;
      }

      if (!isExported({ exports: layout[target].exports, subpath })) {
        context.report({ node, messageId: 'notExported', data: { specifier, target, subpath } });
      } else if (subpath.startsWith('testing/') && !isTestCode) {
        context.report({ node, messageId: 'fakeInSource', data: { specifier, target } });
      } else if (subpath.endsWith('.tool') && composesRun()) {
        context.report({ node, messageId: 'composesRun', data: { from: from.name, target } });
      }
    };

    const checkRelative = (node, specifier) => {
      const resolved = path.resolve(path.dirname(file), specifier);
      const to = workspaceOfFile({ workspaces, file: resolved });

      if (to?.dir !== from.dir) {
        context.report({
          node,
          messageId: 'crossesWorkspace',
          data: { from: from.name, target: to?.name ?? toPosix(path.relative(root, resolved)) },
        });
      } else if (
        checkAppOnlyModule({
          node,
          target: from.name,
          subpath: toPosix(path.relative(path.join(from.dir, 'src'), resolved)),
        })
      ) {
        return;
      } else if (/\.tool(\.js)?$/.test(specifier) && composesRun()) {
        context.report({
          node,
          messageId: 'composesRun',
          data: { from: from.name, target: from.name },
        });
      }
    };

    const check = (node, specifier) => {
      if (typeof specifier !== 'string') return;
      if (specifier.startsWith('.')) checkRelative(node, specifier);
      else checkPackage(node, specifier);
    };

    return specifierVisitors(check);
  },
};
