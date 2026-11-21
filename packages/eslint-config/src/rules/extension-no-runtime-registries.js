// An extension gets run state through the scoped services the host supplies (`services.get(KEY)`
// in `activate`), each built for that extension and narrowed to what its manifest grants. Taking
// the full registries (sessions, tasks, approvals) or building a harness itself skips that, so a
// value import of those modules fails in the non-test source of `extensions/*`: an `import`, a
// re-export, `export * from`, a dynamic `import()`, `require('…')` and `import x = require('…')`.
// Type-only imports (`import type`, `import { type X }`, `export type`) are fine, and so are the
// work factories (`tasks/work.utils`, `tasks/work.types`). The denied modules are the ones the
// host's `Harness` type imports its registries from (`harness-registry-types.utils.js`), plus the
// host helper that builds a harness. A relative path into a workspace's `src/` and a package
// specifier with `..` segments are resolved to the module they reach first. Not covered: files
// under `testing/` and `__tests__` (exempt by file kind), and value imports of the loop's runner
// or of host `*Scope` classes. The rule has no exceptions. Not a sandbox: an extension is Node
// code and can still reach a module through a computed path, `createRequire`, `globalThis` or a
// prototype; review and the manifest's declared services carry that.
import path from 'node:path';
import { LAYOUT_RULE_OPTIONS } from '../layout.utils.js';
import {
  HARNESS_TYPES_FILE,
  moduleOf,
  readHarnessRegistries,
} from '../harness-registry-types.utils.js';
import { extensionRootOf } from './extension-source.utils.js';
import { literalText } from './literal.utils.js';

/** The host helper whose `createHarness` builds the registries. */
const HOST_HELPER = '@sheavly/host/host/host.helper';

const toPosix = (file) => file.split(path.sep).join('/');

/** True if the import brings no value: `import type`, or only inline `type` specifiers. */
function isTypeOnlyImport(node) {
  return (
    node.importKind === 'type' ||
    (node.specifiers.length > 0 && node.specifiers.every((item) => item.importKind === 'type'))
  );
}

/** True if the re-export brings no value: `export type … from`, or only inline `type` specifiers. */
function isTypeOnlyExport(node) {
  return (
    node.exportKind === 'type' ||
    (node.specifiers.length > 0 && node.specifiers.every((item) => item.exportKind === 'type'))
  );
}

/** One error on the file's Program: the rule cannot tell which modules are denied, and says so. */
function reportUnreadable(context) {
  return {
    Program(node) {
      context.report({ node, messageId: 'unreadable', data: { file: HARNESS_TYPES_FILE } });
    },
  };
}

/** A workspace's own source file: `packages/<name>/src/<path>`, the module `@sheavly/<name>/<path>`. */
const WORKSPACE_SOURCE = /^(?:packages|extensions|apps)\/([^/]+)\/src\/(.+)$/;

/**
 * The module a specifier names, the way the denied list writes it: a relative path into another
 * workspace's `src/` becomes its package subpath, and `.` / `..` segments inside a package
 * specifier are resolved, so a path spelled differently still reads as the module it reaches.
 */
function canonicalSource(params) {
  const { source, root, file } = params;

  if (source.startsWith('.')) {
    const target = toPosix(path.relative(root, path.resolve(path.dirname(file), source)));
    const match = WORKSPACE_SOURCE.exec(target);

    return match ? `@sheavly/${match[1]}/${match[2]}` : source;
  }

  return source.startsWith('@sheavly/') ? path.posix.normalize(source) : source;
}

/** The visitors that report a value use of a denied module. */
function visitorsFor(params) {
  const { context, denied, root } = params;
  const check = (node, source) => {
    const module =
      source === undefined
        ? undefined
        : moduleOf(canonicalSource({ source, root, file: context.filename }));

    if (module !== undefined && denied.has(module)) {
      context.report({ node, messageId: 'runtime', data: { module } });
    }
  };

  return {
    ImportDeclaration(node) {
      if (!isTypeOnlyImport(node)) check(node, node.source.value);
    },
    ExportNamedDeclaration(node) {
      if (node.source && !isTypeOnlyExport(node)) check(node, node.source.value);
    },
    ExportAllDeclaration(node) {
      if (node.exportKind !== 'type') check(node, node.source.value);
    },
    ImportExpression(node) {
      check(node, literalText(node.source));
    },
    CallExpression(node) {
      if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
        check(node, literalText(node.arguments[0]));
      }
    },
    TSImportEqualsDeclaration(node) {
      if (node.importKind === 'type') return;

      if (node.moduleReference.type === 'TSExternalModuleReference') {
        check(node, literalText(node.moduleReference.expression));
      }
    },
  };
}

export const extensionNoRuntimeRegistries = {
  meta: {
    type: 'problem',
    schema: [LAYOUT_RULE_OPTIONS],
    messages: {
      runtime:
        'An extension does not value-import `{{module}}`: it holds the full registries (or builds a harness), which skips the per-extension scoping and grants. Read the scoped services with `services.get(KEY)` in `activate` (session-info, child-sessions, background-tasks, task-control, output-reader, output-capture, approvals) and start work through a work factory (`@sheavly/runtime/tasks/work.utils`). A type-only import is fine.',
      unreadable:
        "This rule could not read the host's `Harness` type from `{{file}}` (missing, a syntax error, or no member typed from a `*.service` module imported by name), so it cannot tell which modules are denied. Restore that form, or update `harness/extension-no-runtime-registries`, so extensions stay checked.",
    },
  },
  create(context) {
    const root = extensionRootOf(context);

    if (!root) return {};

    const { registries } = readHarnessRegistries(root);

    if (registries.size === 0) return reportUnreadable(context);

    return visitorsFor({
      context,
      root,
      denied: new Set([HOST_HELPER, ...registries.values()]),
    });
  },
};
