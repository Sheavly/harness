import type { ContextFill, ModelUsage, UsageFigures } from '@sheavly/protocol/usage/usage.types';
import { tokenUsageSchema } from '@sheavly/protocol/usage/usage.validator';

/**
 * `sum`, never past the largest integer a figure may hold. The channel's schema refuses a figure
 * past it, and one entry it refuses ends the channel for good, so a sum a provider's absurd numbers
 * push there is held at the bound instead.
 */
const capped = (sum: number) => Math.min(sum, Number.MAX_SAFE_INTEGER);

/**
 * `usage` as far as it can be counted. A provider's numbers are its own: tokens that are not whole,
 * not negative and not consistent (more cached than were sent) are counted as tokens the provider
 * did not report, and a cost that is not a finite amount of money as no price, so neither can put
 * a figure in a total that the usage channel's schema would refuse.
 */
function trusted(usage: ModelUsage): ModelUsage {
  const { estimatedCostUsd, ...rest } = usage;
  const sane = usage.tokens === null || tokenUsageSchema.safeParse(usage.tokens).success;
  const priced =
    estimatedCostUsd !== undefined && Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0;

  return {
    ...rest,
    tokens: sane ? usage.tokens : null,
    ...(priced && { estimatedCostUsd }),
  };
}

/**
 * `figures` with one more model call counted in: its tokens and cost added, a call that reported no
 * tokens counted as missing (never as zero usage), and one with no price counted as unpriced, its
 * cost adding nothing. Works for a node's record or the total, whichever the figures are in.
 */
export function withCall<Figures extends UsageFigures>(params: {
  figures: Figures;
  usage: ModelUsage;
}): Figures {
  const { figures } = params;
  const { tokens, estimatedCostUsd } = trusted(params.usage);

  return {
    ...figures,
    calls: capped(figures.calls + 1),
    inputTokens: capped(figures.inputTokens + (tokens?.inputTokens ?? 0)),
    outputTokens: capped(figures.outputTokens + (tokens?.outputTokens ?? 0)),
    cacheReadTokens: capped(figures.cacheReadTokens + (tokens?.cacheReadTokens ?? 0)),
    cacheWriteTokens: capped(figures.cacheWriteTokens + (tokens?.cacheWriteTokens ?? 0)),
    estimatedCostUsd: capped(figures.estimatedCostUsd + (estimatedCostUsd ?? 0)),
    missingUsageCalls: capped(figures.missingUsageCalls + (tokens === null ? 1 : 0)),
    unpricedCalls: capped(figures.unpricedCalls + (estimatedCostUsd === undefined ? 1 : 0)),
  };
}

/**
 * How full an agent's context was at this call, or undefined when the call says nothing of it: the
 * call that wrote a summary is billed like any other, but its tokens are not the conversation's
 * context. Each figure is left out when the call did not report it.
 */
export function contextFillOf(usage: ModelUsage): ContextFill | undefined {
  if (usage.purpose === 'summary') return undefined;

  const { tokens, contextWindow } = trusted(usage);

  return {
    ...(tokens && {
      used: capped(tokens.inputTokens + tokens.outputTokens),
      cached: tokens.cacheReadTokens,
    }),
    ...(contextWindow !== undefined && { window: contextWindow }),
  };
}
