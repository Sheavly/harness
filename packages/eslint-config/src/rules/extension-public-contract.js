// `@sheavly/extension` is the contract between the app and the built-in extensions: an extension
// may use as many other libraries as its own substance needs, but it never reaches the app through
// the app's own package, and it takes the contract (the run-service keys, the types the app hands
// it, the errors the scopes throw) from `@sheavly/extension`. In the non-test source of
// `extensions/*` three things fail. (1) Any import of `@sheavly/host`: a static `import`,
// `import type`, a re-export (`export * from` too), a dynamic `import('…')`, a type query
// `import('…').X` and `import x = require('…')`, each with a literal path. (2) An import, from
// another `@sheavly/…` package than `@sheavly/extension`, of a name that package exposes as the
// contract; third-party libraries are not checked, since a name such as `MODEL` is generic. Those
// names are read at lint time from the package's run-services, run-services types and scope errors
// files (`extension-contract.utils.js`), so a new key or type is covered with no edit here.
// Matching is by the imported name, so an alias does not hide it. (3) An import of test code: a
// relative path or `@sheavly/…` path with a `testing` folder, or a `.fake` file, since a fake
// exempt from these rules can import the host and production must not reach it. Not covered: a
// non-literal dynamic import, `require` and `createRequire`, a relative path into another
// workspace's source, an import hidden behind a type-only alias file, a specifier written with
// another casing (the `testing` segment and the `.fake` name are case-sensitive too), a
// `.fake.d.ts` file, a `#` subpath import, and a name matched without its structure.
import { EXTENSION_PACKAGE, readExtensionContract } from '../extension-contract.utils.js';
import { LAYOUT_RULE_OPTIONS } from '../layout.utils.js';
import { extensionRootOf } from './extension-source.utils.js';
import { literalText } from './literal.utils.js';

const HOST_PACKAGE = '@sheavly/host';
const OWN_PACKAGES = '@sheavly/';
const FAKE_FILE = /\.fake(\.[cm]?[jt]sx?)?$/;

const isHost = (source) => source === HOST_PACKAGE || source.startsWith(`${HOST_PACKAGE}/`);
const isExtensionPackage = (source) =>
  source === EXTENSION_PACKAGE || source.startsWith(`${EXTENSION_PACKAGE}/`);

/** True for a relative or own-package specifier that names a `testing` folder or a `.fake` file. */
function isTestCode(source) {
  if (!source.startsWith('.') && !source.startsWith(OWN_PACKAGES)) return false;

  return source.split('/').includes('testing') || FAKE_FILE.test(source);
}

/** The name an import or re-export specifier takes from its module: `{ a as b }` takes `a`. */
function sourceName(specifier) {
  const name = specifier.type === 'ImportSpecifier' ? specifier.imported : specifier.local;

  return name.type === 'Identifier' ? name.name : String(name.value);
}

/** Reports each specifier that takes a name of `contract` from another own package. */
function checkContractNames(params) {
  const { context, contract, source, specifiers } = params;

  if (contract.size === 0 || !source.startsWith(OWN_PACKAGES)) return;
  if (isHost(source) || isExtensionPackage(source)) return;

  for (const specifier of specifiers) {
    if (specifier.type === 'ImportDefaultSpecifier') continue;
    if (specifier.type === 'ImportNamespaceSpecifier') continue;

    const name = sourceName(specifier);
    const path = contract.get(name);

    if (path) context.report({ node: specifier, messageId: 'contract', data: { name, path } });
  }
}

export const extensionPublicContract = {
  meta: {
    type: 'problem',
    schema: [LAYOUT_RULE_OPTIONS],
    messages: {
      host: 'An extension talks to the app through @sheavly/extension, never the host that wires the app: import the service keys, the scope types and the scope errors from `@sheavly/extension/run-services/...` / `errors/scopes.errors`.',
      contract:
        '`{{name}}` is part of the contract @sheavly/extension hands an extension: import it from `{{path}}`, not from another package.',
      fake: 'Production code takes no test fake: a fake may import what an extension must not, and it is not shipped. Move what this extension needs into production code and let the test import the fake.',
    },
  },
  create(context) {
    const root = extensionRootOf(context);

    if (!root) return {};

    // Empty when the package's files are missing or unparsable: the other checks remain.
    const contract = readExtensionContract(root);
    const checkSource = (node, source) => {
      if (source === undefined) return;

      if (isHost(source)) context.report({ node, messageId: 'host' });
      else if (isTestCode(source)) context.report({ node, messageId: 'fake' });
    };
    const checkDeclaration = (node) => {
      const source = node.source.value;

      checkSource(node, source);
      checkContractNames({ context, contract, source, specifiers: node.specifiers ?? [] });
    };

    return {
      ImportDeclaration: checkDeclaration,
      'ExportNamedDeclaration[source]': checkDeclaration,
      ExportAllDeclaration: checkDeclaration,
      ImportExpression: (node) => checkSource(node, literalText(node.source)),
      TSImportType: (node) => checkSource(node, literalText(node.source)),
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type !== 'TSExternalModuleReference') return;

        checkSource(node, literalText(node.moduleReference.expression));
      },
    };
  },
};
