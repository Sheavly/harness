/** A visible representation for one control character, including Unicode format controls. */
export function visibleControl(character: string): string {
  const escaped = JSON.stringify(character).slice(1, -1);

  if (escaped !== character) return escaped;

  return character
    .split('')
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
}

/**
 * What a caught failure says, as plain terminal text (a backend's text is shown, not obeyed): its
 * message, or the value as a string when it is not an Error, then what its causes add, in
 * brackets (`fetch failed (Headers Timeout Error)`). A cause whose words the text already holds
 * adds nothing, and one with no message says its `code`. The one way a failure is printed.
 */
export function describeFailure(caughtError: unknown): string {
  const said = caughtError instanceof Error ? caughtError.message : String(caughtError);
  const causes: string[] = [];
  const seen = new Set<unknown>([caughtError]);

  for (
    let cause = causeOf(caughtError);
    cause !== undefined && !seen.has(cause);
    cause = causeOf(cause)
  ) {
    seen.add(cause);

    const words = causeWords(cause);
    const known = [said, ...causes].some((text) => text.includes(words));

    if (words !== '' && !known) causes.push(words);
  }

  const text = causes.length > 0 ? `${said} (${causes.join(': ')})` : said;

  return plainTerminalText(text);
}

/** What an error was caused by, when it says. */
function causeOf(value: unknown): unknown {
  return value instanceof Error ? value.cause : undefined;
}

/** A cause's message, or its `code` when it has no message (a connection refused on every address). */
function causeWords(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  if (cause.message !== '') return cause.message;

  const code = 'code' in cause ? cause.code : undefined;

  return typeof code === 'string' ? code : '';
}

/** Escape untrusted text before adding terminal styles or links. Markdown newlines and tabs survive. */
export function plainTerminalText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => {
    if (character === '\n' || character === '\t') return character;

    return visibleControl(character);
  });
}
