/**
 * Stops written text from carrying an envelope's tags or a section header of its own. Every `<`
 * is swapped, not just the envelope's spelling, because a model reads many spellings of a tag
 * (spaces, attributes, lookalike characters) and a list of them is never complete; `#` at a line
 * start is escaped so a body cannot start another section. For text a model or a tool wrote and
 * the harness inserts as data inside a fixed envelope.
 */
export function neutralize(text: string): string {
  return escapeTags(text).replaceAll(/^([ \t]*)#/gm, '$1\\#');
}

/**
 * Swaps every `<` so written text cannot close or open an envelope, and changes nothing else. For
 * text that must reach the model whole, such as a sub-agent's report, where a heading is content.
 */
export function escapeTags(text: string): string {
  return text.replaceAll(/[<＜﹤〈❮]/g, '‹');
}

/**
 * A run of dashes longer than any run in `body`, at least three. A fence line built from it
 * (`--- report ---`) cannot appear inside `body`, so text between two such lines cannot end the
 * block early and write what follows as if the harness had.
 */
export function fenceDashes(body: string): string {
  let longest = 0;

  // A loop, not Math.max(...runs): a spread throws a RangeError on a body with very many runs.
  for (const [run] of body.matchAll(/-+/g)) longest = Math.max(longest, run.length);

  return '-'.repeat(Math.max(3, longest + 1));
}

/**
 * Text for a quoted attribute of an envelope tag (`extension="…"`): one escaped line whose `"`
 * becomes `'`, so it cannot end the attribute and add one of its own. Unchanged for a plain name.
 */
export function attributeValue(text: string): string {
  return escapedLine(text).replaceAll('"', "'");
}

/** A title is one line, so it cannot open a section of its own. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * A title, a status or a command as a line of the text the model reads: written by a model, a
 * tool, an extension or read back from a file, so it can neither carry a tag that closes or opens
 * an envelope nor start a line, and so a section, of its own. Control characters (ESC, NEL, the
 * C0 and C1 ranges) and the bidirectional overrides are replaced by a space too: some of them a
 * reader takes for a line break that `\s` does not, and others move or hide the text a person sees.
 * The Unicode tag characters (U+E0000 to U+E007F) are removed: a person sees nothing of them and a
 * model can read them as ASCII text, so they can carry words a reader never sees. (A flag emoji for
 * a region loses its tag sequence and reads as the plain flag.) Use it for every such field a tool
 * result or a notice prints, and `escapeTags` alone for a body whose line breaks are content.
 */
export function escapedLine(text: string): string {
  const visible = escapeTags(text).replaceAll(/[\u{E0000}-\u{E007F}]/gu, '');

  return oneLine(visible.replaceAll(/\p{Cc}|[\u202A-\u202E\u2066-\u2069]/gu, ' '));
}
