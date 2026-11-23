// Every workspace but the server reaches the running server only through the finder, with the
// real handshake. Its source may not import the discovery file, the server lock or the runtime
// folder from `@sheavly/storage` (statically, dynamically or re-exported), and it calls
// `findRunningServer` only directly, with `verify: verifyServer` written in the call: the finder
// reads the file through the safe reader, asks the lock, and hands on the token only after that
// handshake proved the server holds it, so a direct read or another `verify` skips all of it.
// The server (`SERVER_WORKSPACES`), which writes the file and holds the lock, and storage itself
// are exempt; tests and fakes plant and read the file on purpose.
import path from 'node:path';
import { LAYOUT_RULE_OPTIONS, listWorkspaces, workspaceOfFile } from '../layout.utils.js';
import {
  FINDER_MODULE,
  SERVER_INTERNAL_MODULES,
  SERVER_WORKSPACES,
  VERIFY_MODULE,
} from '../server-modules.js';
import { isTestOrFake } from '../test-paths.utils.js';
import { isTypeOnly, specifierVisitors } from './import-node.utils.js';
import { leadingText } from './literal.utils.js';
import { findRoot } from './workspace-types.js';

// A module path, with or without what follows it: `'…/discovery-file' + '/x'` reaches it too.
const SERVER_INTERNALS = new RegExp(
  `^@sheavly/storage/(${SERVER_INTERNAL_MODULES.join('|')})(/|$)`,
);
const FINDER_FOLDER = /^@sheavly\/storage\/server-finder(\/|$)/;
const FINDER = 'findRunningServer';
const EXEMPT = new Set([...SERVER_WORKSPACES, '@sheavly/storage']);

/** The name an import specifier takes from its module: `{ x }` or `{ 'x' as y }`. */
function importedName(specifier) {
  return specifier.imported.name ?? specifier.imported.value;
}

/** The variables a declaration binds to `name` of its module, or to the whole module (`* as`). */
function boundTo(params) {
  const { sourceCode, node, name } = params;

  return node.specifiers
    .filter(
      (specifier) =>
        specifier.type === 'ImportNamespaceSpecifier' ||
        (specifier.type === 'ImportSpecifier' && importedName(specifier) === name),
    )
    .flatMap((specifier) =>
      sourceCode
        .getDeclaredVariables(specifier)
        .map((variable) => ({ variable, namespace: specifier.type !== 'ImportSpecifier' })),
    );
}

/** Whether `identifier` is named in a type (`typeof findRunningServer`), where nothing runs. */
function inTypeQuery(identifier) {
  let node = identifier.parent;

  while (node?.type === 'TSQualifiedName') node = node.parent;

  return node?.type === 'TSTypeQuery';
}

/** The key of a member access when it is known: `ns.x` or `ns['x']`; undefined when computed. */
function memberKey(member) {
  if (!member.computed) return member.property.name;

  return member.property.type === 'Literal' ? member.property.value : undefined;
}

/**
 * What a namespace reference is: `ns.findRunningServer` (the finder, to check as a call),
 * `ns.otherExport` (nothing to check), or anything else (`ns[key]`, the namespace passed on),
 * which may be the finder and is reported.
 */
function namespaceUse(identifier) {
  const member = identifier.parent;

  // The namespace itself, passed on or destructured, may carry the finder anywhere.
  if (member?.type !== 'MemberExpression' || member.object !== identifier) {
    return { value: identifier };
  }

  const key = memberKey(member);

  if (key === FINDER) return { call: member };

  return key === undefined ? { value: member } : undefined;
}

/**
 * Each place the finder is named, as `{ call }` (it must be called right there, with the check)
 * or `{ value }` (it is passed on, stored or reached through a computed key: reported).
 */
function finderUses(bindings) {
  return bindings.flatMap(({ variable, namespace }) =>
    variable.references
      .map(({ identifier }) => identifier)
      .filter((identifier) => !inTypeQuery(identifier))
      .map((identifier) => (namespace ? namespaceUse(identifier) : { call: identifier }))
      .filter(Boolean),
  );
}

/** The name a property is known by: `verify`, `'verify'`; undefined for a computed key. */
function propertyName(property) {
  if (property.type !== 'Property' || property.computed) return undefined;

  return property.key.name ?? property.key.value;
}

/**
 * Whether the call's options name `verify: verifyServer` themselves, once, with nothing else
 * that could set it: no spread and no computed key (the last `verify` an object gets wins).
 */
function verifiedBy(params) {
  const { options, verifiers } = params;

  if (options?.type !== 'ObjectExpression') return false;

  const { properties } = options;

  if (properties.some((property) => propertyName(property) === undefined)) return false;

  const named = properties.filter((property) => propertyName(property) === 'verify');

  return named.length === 1 && named[0].kind === 'init' && verifiers.has(named[0].value);
}

export const serverThroughFinder = {
  meta: {
    type: 'problem',
    schema: [LAYOUT_RULE_OPTIONS],
    messages: {
      direct: `{{from}} reaches the running server only through findRunningServer (${FINDER_MODULE}), with verifyServer as its handshake: the finder reads the discovery file through the safe reader, asks the lock, and hands on the token only after the server proved it holds it. Importing {{specifier}} directly skips that; only the server (${SERVER_WORKSPACES.join(', ')}) and storage itself use those modules. Use the finder.`,
      verify: `findRunningServer hands on the server's token once its handshake says "verified", so call it with \`verify: verifyServer\` (imported from ${VERIFY_MODULE}) written in the call: another function, a wrapper or a spread could say "verified" for a server that never proved it holds the token.`,
      finderValue:
        'Call findRunningServer here, directly, with `verify: verifyServer` in the call: passed on, stored, re-exported, called through `.call`/`.apply`/`.bind` or reached through a computed key, it could be called with another handshake.',
      finderDynamic: `Import findRunningServer statically from ${FINDER_MODULE}: through import() its call can't be checked for \`verify: verifyServer\`.`,
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const root = options.root ?? findRoot(context.cwd);

    if (!root) return {};

    const from = workspaceOfFile({ workspaces: listWorkspaces(root), file: context.filename });
    const relative = from && path.relative(from.dir, context.filename).split(path.sep).join('/');

    if (!from || EXEMPT.has(from.name) || isTestOrFake(relative)) return {};

    const { sourceCode } = context;
    const finders = [];
    const verifyServers = [];

    const check = (node, specifier) => {
      if (typeof specifier !== 'string' || !SERVER_INTERNALS.test(specifier)) return;
      if (isTypeOnly(node)) return;

      context.report({ node, messageId: 'direct', data: { from: from.name, specifier } });
    };
    const visitors = specifierVisitors(check);

    // Re-exported, the finder is called in another module, where nothing checks its handshake.
    const checkReexport = (node) => {
      if (node.source?.value !== FINDER_MODULE || isTypeOnly(node)) return;

      const passesFinder =
        node.type === 'ExportAllDeclaration' ||
        node.specifiers.some(
          (specifier) => (specifier.local.name ?? specifier.local.value) === FINDER,
        );

      if (passesFinder) context.report({ node, messageId: 'finderValue' });
    };

    return {
      ...visitors,
      // A specifier that starts with a server module's path reaches it, whatever follows.
      ImportExpression(node) {
        const start = leadingText(node.source);

        check(node, start);

        if (typeof start === 'string' && FINDER_FOLDER.test(start)) {
          context.report({ node, messageId: 'finderDynamic' });
        }
      },
      ExportNamedDeclaration(node) {
        visitors.ExportNamedDeclaration(node);
        checkReexport(node);
      },
      ExportAllDeclaration(node) {
        visitors.ExportAllDeclaration(node);
        checkReexport(node);
      },
      ImportDeclaration(node) {
        visitors.ImportDeclaration(node);

        if (isTypeOnly(node)) return;

        if (node.source.value === FINDER_MODULE) {
          finders.push(...boundTo({ sourceCode, node, name: FINDER }));
        }

        if (node.source.value === VERIFY_MODULE) {
          verifyServers.push(...boundTo({ sourceCode, node, name: 'verifyServer' }));
        }
      },
      'Program:exit'() {
        const verifiers = new Set(
          verifyServers
            .filter(({ namespace }) => !namespace)
            .flatMap(({ variable }) => variable.references.map(({ identifier }) => identifier)),
        );

        for (const use of finderUses(finders)) {
          const node = use.call ?? use.value;
          const call = node.parent;

          // Anything but a call right here (`.call`, `.bind`, stored, passed on) is a value.
          if (use.value || call?.type !== 'CallExpression' || call.callee !== node) {
            context.report({ node, messageId: 'finderValue' });
          } else if (!verifiedBy({ options: call.arguments[0], verifiers })) {
            context.report({ node: call, messageId: 'verify' });
          }
        }
      },
    };
  },
};
