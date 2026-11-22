import path from 'node:path';
import { listWorkspaces, readLayout, workspaceOfFile } from '../layout.utils.js';
import { isTestOrFake } from '../test-paths.utils.js';
import { findRoot } from './workspace-types.js';

const SOURCE_FILE = /\.[cm]?tsx?$/;

/**
 * The repo root when the linted file is extension source (a TypeScript file of an extension
 * workspace that is not a test or a fake), else undefined: the rule then has nothing to check.
 * Reads the root from the rule's `root` option, else from the working directory.
 */
export function extensionRootOf(context) {
  return extensionWorkspaceOf(context)?.root;
}

/**
 * The repo root and the workspace (`{ dir, relative, name, manifest }`) of the linted file when it
 * is extension source, as `extensionRootOf` decides, else undefined.
 */
export function extensionWorkspaceOf(context) {
  const options = context.options[0] ?? {};
  const root = options.root ?? findRoot(context.cwd);

  // Cheap checks first: a file that is not extension source pays for no parse or stat.
  if (!root || !SOURCE_FILE.test(context.filename)) return undefined;

  const workspace = extensionWorkspaceOfFile({ root, options, file: context.filename });

  return workspace ? { root, workspace } : undefined;
}

/** The workspace of `file` when it is non-test source of one the layout calls an extension. */
function extensionWorkspaceOfFile(params) {
  const { root, options, file } = params;
  const workspace = workspaceOfFile({ workspaces: listWorkspaces(root), file });

  if (!workspace || isTestOrFake(path.relative(workspace.dir, file))) return undefined;

  const layout = options.layout ?? readLayout({ root });

  return layout[workspace.name]?.kind === 'extension' ? workspace : undefined;
}

/** True if `file` is non-test source of a workspace the layout calls an extension. */
export function isExtensionSource(params) {
  return extensionWorkspaceOfFile(params) !== undefined;
}

/** The variable `name` names from `scope` outwards, or undefined when it is not declared. */
export function findVariable(params) {
  const { scope, name } = params;

  for (let current = scope; current; current = current.upper) {
    const variable = current.set.get(name);

    if (variable) return variable;
  }

  return undefined;
}
