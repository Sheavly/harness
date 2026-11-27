import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const terminal = path.resolve(import.meta.dirname, '../../../../apps/terminal');
const eslint = new ESLint({ cwd: terminal });
const RULE = '@typescript-eslint/switch-exhaustiveness-check';

/** The source of a file of the terminal's `render/` folder, which the Renderer draws through. */
const sourceOf = (name) => {
  const file = path.join(terminal, 'src/render', name);

  return { file, text: fs.readFileSync(file, 'utf8') };
};

/** The rule's messages for `name` after `change`. */
async function exhaustivenessErrors(params) {
  const { name, change } = params;
  const { file, text } = sourceOf(name);
  const [result] = await eslint.lintText(change(text), { filePath: file });

  return result.messages.filter((message) => message.ruleId === RULE);
}

// The first lint builds a type-checked program for the Renderer and the workspace sources it
// imports. Measured alone it took 2.5 to 11 s depending on the machine, and the 30 s default was
// exceeded in full `npm run check` runs (#331); the cost beside the other workspaces' tests was
// not measured. The rule needs those types, so the budget is raised, not the check weakened.
const TYPED_LINT_TIMEOUT_MS = 60_000;

// Each switch is in the file that draws it: the Renderer's events and items, the sub-agent lines
// (a session update, a card's change) and the events that need no state.
const SWITCHES = [
  ['an event', 'render.service.ts', "      case 'usage':\n"],
  ['a chat item', 'render.service.ts', "      case 'run_started':\n"],
  ['an event that needs no state', 'notice-line.utils.ts', "    case 'turn_end':\n"],
  ['a session update', 'sub-agent.utils.ts', "    case 'session_released':\n"],
  ['a change of a card', 'sub-agent.utils.ts', "    case 'status':\n"],
];

describe(
  'the Renderer handles every event, item and session update kind',
  { timeout: TYPED_LINT_TIMEOUT_MS },
  () => {
    it.each([...new Set(SWITCHES.map(([, name]) => name))])(
      'passes as written: %s',
      async (name) => {
        expect(await exhaustivenessErrors({ name, change: (text) => text })).toEqual([]);
      },
    );

    it.each(SWITCHES)('fails when %s kind is left out of its switch', async (_name, name, line) => {
      expect(sourceOf(name).text).toContain(line);

      const errors = await exhaustivenessErrors({
        name,
        change: (text) => text.replace(line, ''),
      });

      expect(errors).toHaveLength(1);
    });
  },
);
