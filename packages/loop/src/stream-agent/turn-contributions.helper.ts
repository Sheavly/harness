import type { SummaryOptions } from '@sheavly/core/summary/summary.types';
import { summarizeAtThreshold, summarizeHistory } from '../summary/summarize.helper.js';
import { maskOldToolOutput } from '../summary/mask.utils.js';
import { continueAfterLostConnection, continueAfterOutputLimit } from './output-recovery.helper.js';
import { orderContributions } from './contributions.helper.js';
import { awaitTask, yieldEnds } from './completion.helper.js';
import { deliverExtensionNotices, deliverMessages, runDeliveryHooks } from './delivery.helper.js';
import { reportFinishedTasks } from './task-delivery.helper.js';
import type {
  Contribution,
  DeliveryInput,
  LimitInput,
  LimitOutcome,
  OverflowInput,
  TurnContributions,
} from './contributions.types.js';
import type { AgentOptions } from './stream-agent.types.js';

/**
 * Start of a turn, in order: steering messages, finished work, failed hooks, notices from
 * extensions, then the hooks that watch deliveries. Finished work, failures and extension notices
 * are in history before any hook sees them (`notice` hooks are not offered the last two kinds).
 */
const DELIVERY: Contribution<DeliveryInput, void>[] = [
  {
    name: 'steering-messages',
    onFailure: 'fail-run',
    abort: 'wait',
    run: ({ context, state }) => {
      deliverMessages(context);
      // A follow-up already in the inbox belongs in the completion's messages-since snapshot, so
      // the notices of this turn start after it.
      state.noticesFrom = context.messages.length;
    },
  },
  {
    name: 'finished-tasks',
    after: ['steering-messages'],
    onFailure: 'fail-run',
    abort: 'wait',
    run: ({ context, state }) => {
      const { options, session, messages, events } = context;

      state.tasks = reportFinishedTasks({ tasks: options.tasks, session, messages, events });
    },
  },
  {
    name: 'hook-failures',
    after: ['finished-tasks'],
    onFailure: 'fail-run',
    abort: 'wait',
    // The model hears of handlers that failed since the last call, once.
    run: ({ context }) => context.hookFailures.deliver(context.messages),
  },
  {
    name: 'extension-notices',
    after: ['hook-failures'],
    // A notice an extension queued is not worth the run: a failed drain is reported like a failed
    // hook (`hook_failed`) and the turn goes on.
    onFailure: 'report',
    abort: 'wait',
    run: ({ context }) => deliverExtensionNotices(context),
  },
  {
    name: 'delivery-hooks',
    after: ['extension-notices'],
    onFailure: 'fail-run',
    abort: 'race',
    run: ({ context, state }) =>
      runDeliveryHooks({ context, delivered: state.tasks, noticesFrom: state.noticesFrom }),
  },
];

/**
 * How a finished turn decides whether the run ends, first answer wins: tools still running, the
 * inbox, a requested yield, waiting on awaited work, and last the answer that always takes the
 * turn. The order is the flow rules: a yield outranks task completions but not `await_tasks`.
 */
const COMPLETION: Contribution<LimitInput, LimitOutcome | undefined>[] = [
  {
    name: 'running-tools',
    onFailure: 'fail-run',
    abort: 'wait',
    run: ({ running }) => (running.length > 0 ? { ended: undefined } : undefined),
  },
  {
    name: 'inbox',
    after: ['running-tools'],
    onFailure: 'fail-run',
    abort: 'wait',
    // Messages from a parent agent wake the model without touching tasks or groups.
    run: ({ context }) =>
      context.session.registry.hasMessages(context.session.ref.id)
        ? { ended: undefined }
        : undefined,
  },
  {
    name: 'yield',
    after: ['inbox'],
    onFailure: 'fail-run',
    abort: 'wait',
    run: ({ context }) =>
      yieldEnds({ options: context.options, id: context.session.ref.id })
        ? { ended: 'completed' }
        : undefined,
  },
  {
    name: 'await-tasks',
    after: ['yield'],
    onFailure: 'fail-run',
    // `awaitTask` watches the abort itself and must clean up its waiters before returning.
    abort: 'wait',
    run: async ({ context }) =>
      (await awaitTask({
        options: context.options,
        session: context.session,
        signal: context.signal,
        events: context.events,
      }))
        ? { ended: undefined }
        : undefined,
  },
  {
    name: 'settled',
    after: ['await-tasks'],
    onFailure: 'fail-run',
    abort: 'wait',
    run: ({ context }) => ({ ended: context.signal.aborted ? 'interrupted' : 'completed' }),
  },
];

/**
 * The turn's features for one run, ordered and checked once at its start. Which features exist is
 * decided here, from the options, and nowhere else: a feature absent from a list is absent from
 * the turn, so `runTurn` never tests an option to know. Masking and overflow recovery exist only
 * with a `summary` option, since both trade on a checkpoint being possible.
 */
export function buildContributions(options: AgentOptions): TurnContributions {
  const { summary } = options;

  return {
    room: orderContributions(
      summary
        ? [
            {
              name: 'summarize-at-threshold',
              onFailure: 'fail-run' as const,
              abort: 'wait' as const,
              run: async (context) =>
                (await summarizeAtThreshold({ context, config: summary })) === 'full'
                  ? ('full' as const)
                  : undefined,
            },
          ]
        : [],
    ),
    delivery: orderContributions(DELIVERY),
    completion: orderContributions(COMPLETION),
    view: orderContributions(
      summary
        ? [
            {
              name: 'mask-old-tool-output',
              onFailure: 'fail-run' as const,
              abort: 'wait' as const,
              run: maskOldToolOutput,
            },
          ]
        : [],
    ),
    overflow: orderContributions(
      summary
        ? [
            {
              name: 'summarize-on-overflow',
              onFailure: 'fail-run' as const,
              abort: 'wait' as const,
              run: (input) => summarizeOnOverflow({ ...input, config: summary }),
            },
          ]
        : [],
    ),
    dropped: orderContributions([
      {
        name: 'continue-after-lost-connection',
        onFailure: 'fail-run' as const,
        abort: 'wait' as const,
        run: continueAfterLostConnection,
      },
    ]),
    limit: orderContributions([
      {
        name: 'window-exceeded',
        onFailure: 'fail-run' as const,
        abort: 'wait' as const,
        run: ({ stopReason }) =>
          stopReason === 'context_window_exceeded'
            ? { ended: 'context_window_exceeded' as const }
            : undefined,
      },
      {
        name: 'output-limit',
        after: ['window-exceeded'],
        onFailure: 'fail-run' as const,
        abort: 'wait' as const,
        run: ({ context, stopReason, running, reply }) => {
          if (stopReason !== 'max_tokens') {
            context.outputRecovery.fruitless = 0;

            return undefined;
          }

          // Reasoning alone is not progress: a provider drops unfinished thinking, so only text or
          // a tool call proves the next attempt can get further than this one.
          const progressed =
            reply.role === 'assistant' && (reply.content !== '' || running.length > 0);

          return { ended: continueAfterOutputLimit({ context, progressed }) };
        },
      },
    ]),
  };
}

/**
 * A call the provider rejected as too long gets one summary and a retry, once per model call (a
 * call that ends any other way re-arms it), so it cannot loop. True when a checkpoint was
 * appended: the turn drops the rejected reply and the next turn calls the model again.
 */
async function summarizeOnOverflow(
  params: OverflowInput & { config: SummaryOptions },
): Promise<boolean> {
  const { context, config, stopReason, started } = params;
  const { summaryFailures } = context;

  if (stopReason !== 'context_window_exceeded') {
    summaryFailures.overflowTried = false;

    return false;
  }

  if (started || summaryFailures.overflowTried) return false;

  summaryFailures.overflowTried = true;

  return summarizeHistory({ context, config, reason: 'overflow' });
}
