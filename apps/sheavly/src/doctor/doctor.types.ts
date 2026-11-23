/**
 * What one check of `sheavly doctor` found. `lines` is the reason, one line each: the first is the
 * summary, the rest what to do or what else was seen. None holds the token or a file's content.
 */
export type Finding = {
  label: string;
  ok: boolean;
  lines: readonly string[];
};
