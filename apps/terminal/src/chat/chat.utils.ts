import { completeSkillMention } from '@sheavly/coding/skills/skills.utils';
import { CHAT_COMMANDS, EXIT_COMMANDS } from './chat.constants.js';
import type { ModelChoice } from '@sheavly/protocol/server/server.types';
import type { ModelId } from '@sheavly/protocol/model/model.types';
import type { SkillInfo } from '@sheavly/protocol/skill/skill.types';
import type { EntryEvent } from '@sheavly/protocol/event/event.types';
import type { ChatItem } from '../client/transcript.types.js';
import type { ChatInput, RunState } from './chat.types.js';

/**
 * The originating message of a main run that failed, for the user to look up in the
 * conversation's `log.jsonl`; undefined for any other event or a failure without one.
 */
export function failedRunMessage(item: Extract<ChatItem, { type: 'event' }>): string | undefined {
  return item.event.type === 'run_failed' ? item.messageId : undefined;
}

/** The `run_state` a main agent's event carries, or undefined for any other event. */
export function runStateOf(event: EntryEvent): RunState | undefined {
  if (event.type !== 'run_state') return undefined;

  return { state: event.state, groupedTasks: event.groupedTasks };
}

/**
 * Reads one line of chat input: the chat's own commands, or a message to send. A message can
 * mention skills (`/<name>`) anywhere in it; `skillRequest` runs them.
 */
export function parseChatInput(line: string): ChatInput {
  const text = line.trim();

  if (text === '') return { kind: 'empty' };
  if (EXIT_COMMANDS.includes(text)) return { kind: 'exit' };
  if (text === '/help') return { kind: 'help' };

  const [command, ...rest] = text.split(/\s+/);

  if (command === '/help') return { kind: 'usage', message: '/help takes no arguments.' };

  if ((command === '/model' || command === '/effort') && rest.length > 1) {
    return { kind: 'usage', message: `${command} takes at most one name.` };
  }

  if (command === '/model') return { kind: 'model', name: rest[0] };
  if (command === '/effort') return { kind: 'effort', name: rest[0] };
  if (command === '/changes') return { kind: 'changes', target: rest.join(' ') || undefined };
  if (command === '/errors') return { kind: 'errors', target: rest.join(' ') || undefined };

  return { kind: 'prompt', text };
}

/**
 * The command a message that ran no skill starts with, when no skill has that name (`/nope do
 * this`): a typo is reported, not sent. A mention later in the text is sent as it is.
 */
export function unknownCommand(params: { text: string; unknown: string[] }): string | undefined {
  const { text, unknown } = params;

  return unknown.find((name) => new RegExp(`^/${name}(\\s|$)`).test(text));
}

/** What `/model` prints: each model of the profile, the active one marked, with the id to switch by. */
export function listModels(params: {
  choices: ModelChoice[];
  active: ModelId | undefined;
}): string {
  const { choices, active } = params;

  return choices
    .map(
      ({ id, name, adapter, model }) =>
        `${id === active ? '●' : '○'} ${name}: ${adapter} / ${model} (${id})`,
    )
    .join('\n');
}

/**
 * Which model the user means by what they typed after `/model`: an id picks that model, and a
 * label picks the model it names. Only the id is the model; a label is a way to find it, so a
 * label two models share picks none (`ambiguous`, with those models) and the user is asked for
 * the id. The reply carries the id the switch is sent with.
 */
export function pickModel(params: {
  choices: ModelChoice[];
  typed: string;
}):
  | { kind: 'found'; choice: ModelChoice }
  | { kind: 'ambiguous'; choices: ModelChoice[] }
  | { kind: 'none' } {
  const { choices, typed } = params;
  const byId = choices.find((choice) => choice.id === typed);

  if (byId) return { kind: 'found', choice: byId };

  const [first, ...others] = choices.filter((choice) => choice.name === typed);

  if (first && others.length === 0) return { kind: 'found', choice: first };
  if (first) return { kind: 'ambiguous', choices: [first, ...others] };

  return { kind: 'none' };
}

/**
 * Tab completion for the chat line (readline's `[completions, replaced]`): the `/<partial>` just
 * before the cursor completes to the skills that fit, and, at the start of the line, to the chat's
 * own commands too. `before` is the line up to the cursor. Nothing to offer is `[[], before]`.
 */
export function completeChatLine(params: {
  before: string;
  skills: SkillInfo[];
}): [string[], string] {
  const { before, skills } = params;
  const completion = completeSkillMention({ text: before, cursor: before.length, skills });

  if (!completion) return [[], before];

  const typed = before.slice(completion.start);
  const commands = completion.start === 0 ? CHAT_COMMANDS.filter((c) => c.startsWith(typed)) : [];

  return [[...commands, ...completion.matches.map(({ name }) => `/${name}`)], typed];
}
