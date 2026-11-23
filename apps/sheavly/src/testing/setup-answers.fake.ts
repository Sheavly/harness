type Item = { value: string };

/** What the wizard asks of the user; the same shape as the terminal's `SetupUi`, structurally. */
type Ui = {
  signal: AbortSignal;
  text: (question: { title: string; secret?: boolean; initial?: string }) => Promise<string>;
  choose: (question: {
    title: string;
    items: readonly Item[];
    initial?: string;
  }) => Promise<string>;
  notice: (message: string) => void;
};

type ChoiceAnswer = string | ((items: readonly Item[]) => string);

/**
 * Test-only: answers the setup wizard's questions by their title, so a test states what it cares
 * about (the key, the model's address) and takes the default for the rest. A question's `title`
 * starts with a rule's key (a long one carries its description after a line break). A question
 * with no rule gets its initial value, and a secret one or one with no initial value fails the
 * test, naming it: nothing is answered by guessing. `asked` records every question, with whether
 * it was secret, and `notices` what the wizard said.
 */
export function answerSetupByTitle(rules: {
  text?: Record<string, string>;
  choices?: Record<string, ChoiceAnswer>;
}): {
  ui: Ui;
  asked: { kind: 'text' | 'choose'; title: string; secret: boolean }[];
  notices: string[];
} {
  const asked: { kind: 'text' | 'choose'; title: string; secret: boolean }[] = [];
  const notices: string[] = [];
  const ruleFor = <T>(table: Record<string, T> | undefined, title: string): T | undefined =>
    Object.entries(table ?? {}).find(([prefix]) => title.startsWith(prefix))?.[1];

  const ui: Ui = {
    signal: new AbortController().signal,
    text: (question) => {
      asked.push({ kind: 'text', title: question.title, secret: question.secret === true });

      const answer = ruleFor(rules.text, question.title);

      if (answer !== undefined) return Promise.resolve(answer);

      if (question.initial !== undefined && question.secret !== true) {
        return Promise.resolve(question.initial);
      }

      return Promise.reject(
        new Error(`No scripted answer for the text question ${question.title}`),
      );
    },
    choose: (question) => {
      asked.push({ kind: 'choose', title: question.title, secret: false });

      const answer = ruleFor(rules.choices, question.title);

      if (answer !== undefined) {
        return Promise.resolve(typeof answer === 'function' ? answer(question.items) : answer);
      }

      if (question.initial !== undefined) return Promise.resolve(question.initial);

      return Promise.reject(new Error(`No scripted answer for the choice ${question.title}`));
    },
    notice: (message) => {
      notices.push(message);
    },
  };

  return { ui, asked, notices };
}
