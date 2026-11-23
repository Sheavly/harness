/**
 * The size in bytes of a JSON value once serialized as UTF-8, as the stream and history store it.
 * A value that cannot be serialized (a cycle) has no size, so it is reported as infinitely large
 * and fails any cap, instead of throwing out of a parse.
 */
export function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch (caughtError) {
    // `JSON.stringify` raises a TypeError for a cycle and for a BigInt: neither is JSON.
    if (caughtError instanceof TypeError) return Number.POSITIVE_INFINITY;

    throw caughtError;
  }
}

/** True when `name` is in `extension`'s namespace: it starts with `<extension>.`. */
export function isInNamespace(params: { extension: string; name: string }): boolean {
  return params.name.startsWith(`${params.extension}.`);
}
