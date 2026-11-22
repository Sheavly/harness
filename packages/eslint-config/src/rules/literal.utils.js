/**
 * The text of a string literal or an expression-free template, else undefined (a computed path).
 * Every rule that reads a module specifier uses this, so `` import(`x`) `` is checked like `'x'`
 * everywhere.
 */
export function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;

  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? undefined;
  }

  return undefined;
}
