import type { PromptPart } from './message.types.js';

/**
 * What a person typed as `parts`, as one text: each picked skill as its `/<name>` mention. It is
 * how a prompt is shown and matched when only its text is kept, never what the model is sent.
 */
export function partsText(parts: readonly PromptPart[]): string {
  return parts.map((part) => (part.type === 'text' ? part.text : `/${part.name}`)).join('');
}
