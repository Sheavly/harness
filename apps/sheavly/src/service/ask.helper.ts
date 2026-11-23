import { createInterface } from 'node:readline/promises';

/**
 * Asks `question` on the terminal and says whether the answer was yes (`y` or `yes`, any case).
 * Anything else, an empty line included, is no: a question about changing the user's system never
 * goes ahead on a guess. It needs a terminal; the caller checks before asking.
 */
export async function askYesNo(question: string): Promise<boolean> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const answer = await lines.question(question);

    return /^y(es)?$/i.test(answer.trim());
  } finally {
    lines.close();
  }
}
