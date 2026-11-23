import type { StreamEvent } from '@sheavly/core/message/message.types';
import type { Provider, ProviderRequest } from '@sheavly/core/provider/provider.types';
import type { HistoryMessage } from '@sheavly/protocol/history/history.types';
import { SessionRegistry } from '@sheavly/runtime/sessions/sessions.service';
import { TaskRegistry } from '@sheavly/runtime/tasks/tasks.service';
import { scriptedProvider } from '@sheavly/testing/provider/scripted-provider.fake';
import { until } from '@sheavly/testing/wait/until.fake';
import { createTaskTools } from '@sheavly/tools/tasks/tasks.tool';
import { runSession } from '../stream-agent/stream-agent.helper.js';
import { say } from './work-kinds.fake.js';
import type { WorkKind, WorkSpeed } from './work-kinds.types.js';

const open: TaskRegistry[] = [];

export const userPrompt = (content = 'go'): HistoryMessage[] => [{ role: 'user', content }];

/** Stops everything the flows of one test started; call it from `afterEach`. */
export async function cancelOpenFlows(): Promise<void> {
  await Promise.all(open.splice(0).map((tasks) => tasks.cancelAll()));
}

/**
 * A main session with the kind's tools and the task tools, on registries of their own. `options`
 * is what the loop needs to run it; the caller adds the provider and the messages.
 */
export function startFlow(kind: WorkKind) {
  const sessions = new SessionRegistry();
  const tasks = new TaskRegistry(sessions.nodeOwners);
  const ref = sessions.startMain({ title: 'Chat' });
  const tools = [...kind.tools({ tasks, sessions }), ...createTaskTools(tasks)];

  open.push(tasks);

  return {
    tasks,
    sessions,
    ref,
    options: {
      tasks,
      tools,
      session: { registry: sessions, ref },
      keepSession: true,
      // The main session: only `await_tasks` holds it open.
      holdOpenFor: 'awaited' as const,
    },
  };
}

/** A run that starts slow work of `kind` and can be stopped through `stopping`. */
export function startStoppable(kind: WorkKind) {
  const flow = startFlow(kind);
  const stopping = new AbortController();
  const { provider } = recordingProvider([
    kind.start({ speed: 'slow', id: 'c1' }),
    say('Started.'),
  ]);
  const run = runSession({
    ...flow.options,
    provider,
    messages: userPrompt(),
    signal: stopping.signal,
  });

  return { ...flow, stopping, run };
}

/** True if the promise settles within `ms`; the promise itself is left running. */
export async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const timer = Promise.withResolvers<false>();
  const handle = setTimeout(() => timer.resolve(false), ms);
  const settled = await Promise.race([promise.then(() => true as const), timer.promise]);

  clearTimeout(handle);

  return settled;
}

/** Plays back scripted turns and keeps every request the model was sent. */
export function recordingProvider(turns: StreamEvent[][]) {
  const inner = scriptedProvider(turns);
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    stream: (request) => {
      requests.push(request);

      return inner.stream(request);
    },
  };

  return { provider, requests };
}

/** The kinds of the notices stored in a history, in order. */
export function noticeKinds(messages: readonly HistoryMessage[]): string[] {
  return messages.flatMap((message) => (message.role === 'notice' ? [message.notice.kind] : []));
}

/**
 * Starts one piece of background work of `kind` and runs until its finished notice has reached
 * the model. No work holds the main session open, so the notice reaches the next run, started
 * here once the work has finished.
 */
export async function runUntilNotified(kind: WorkKind, speed: WorkSpeed = 'quick') {
  const flow = startFlow(kind);
  const round = await runRound({ flow, kind, speed, id: 'c1', messages: userPrompt() });

  return { ...flow, ...round };
}

/**
 * One prompt on a running flow: starts work of `kind` and runs until its notice has reached the
 * model, in this run or, when the work finishes after it, in a second one. `resumed` is for a
 * flow that already ran a prompt.
 */
export async function runRound(params: {
  flow: ReturnType<typeof startFlow>;
  kind: WorkKind;
  speed: WorkSpeed;
  id: string;
  messages: HistoryMessage[];
  resumed?: boolean;
}) {
  const { flow, kind, speed, id, messages, resumed } = params;
  const first = recordingProvider([kind.start({ speed, id }), say('Started.'), say('Saw it.')]);
  const firstRun = await runSession({
    ...flow.options,
    provider: first.provider,
    messages,
    ...(resumed && { resumed }),
  });

  // Work that finished before the model's turn ended is delivered by this run (a ready notice
  // continues it once); otherwise its notice reaches the next run.
  if (noticeKinds(firstRun.messages).length > noticeKinds(messages).length) {
    return { ...firstRun, requests: first.requests };
  }

  await until(() => flow.tasks.hasDeliveries(flow.ref.id));
  flow.sessions.resume(flow.ref.id);
  const next = recordingProvider([say('Saw it.')]);
  const nextRun = await runSession({
    ...flow.options,
    provider: next.provider,
    messages: [...firstRun.messages, { role: 'user', content: 'next' }],
    resumed: true,
  });

  return { ...nextRun, requests: next.requests };
}
