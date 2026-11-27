import type { ContextFill, UsageFigures } from '@sheavly/protocol/usage/usage.types';
import { contextWindowLabel } from '@sheavly/protocol/model/model.utils';

function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;

  return `${(value / 1_000_000).toFixed(1)}m`;
}

function percentage(context: ContextFill | undefined): string {
  if (context?.window === undefined || context.used === undefined) return '';

  return ` (${String(Math.round((context.used / context.window) * 100))}%)`;
}

/**
 * Whether the backend has counted no model call and knows of none it missed (an older conversation's
 * calls before the backend counted are not counted, and say so with `incomplete`): the context is
 * then known to be empty.
 */
function noCallYet(usage: UsageFigures | undefined): boolean {
  return usage?.calls === 0 && !usage.incomplete && usage.missingUsageCalls === 0;
}

/**
 * Last-call context measurement alongside cumulative cost. A context nobody measured is `?`, never
 * zero, except before the first model call of a conversation, when it is known to be zero.
 */
export function usageText(params: {
  context: ContextFill | undefined;
  usage: UsageFigures | undefined;
}): string {
  const { context, usage } = params;
  const unmeasured = noCallYet(usage) ? '0' : '?';
  const used = context?.used === undefined ? unmeasured : tokens(context.used);
  const window = context?.window;
  const capacity = window === undefined ? '' : ` / ${contextWindowLabel(window)}`;
  const cache = context?.cached === undefined ? '' : ` · cache ${tokens(context.cached)}`;
  const measured = `context ${used}${capacity}${percentage(context)}${cache}`;

  if (!usage || usage.calls === 0 || usage.incomplete || usage.missingUsageCalls > 0) {
    return measured;
  }

  if (usage.unpricedCalls > 0) return measured;

  return `${measured} · ~$${usage.estimatedCostUsd.toFixed(4)}`;
}
