// What the rules that check module specifiers share: which import brings in types only, and the
// visitors that hand them every specifier a file names, so each form is read the same way.
import { literalText } from './literal.utils.js';

/** True when an import or export brings in types only, so nothing of the module runs. */
export function isTypeOnly(node) {
  if (node.importKind === 'type' || node.exportKind === 'type') return true;

  return (
    node.specifiers?.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.importKind === 'type' || specifier.exportKind === 'type',
    )
  );
}

/**
 * The visitors that call `check(node, specifier)` for every module specifier a file names: import
 * and export declarations, and an `import()` whose specifier is known without running code (a
 * string, or a template with no `${}`; anything else is `undefined`).
 */
export function specifierVisitors(check) {
  return {
    ImportDeclaration: (node) => check(node, node.source.value),
    ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
    ExportAllDeclaration: (node) => check(node, node.source.value),
    ImportExpression: (node) => check(node, literalText(node.source)),
  };
}
