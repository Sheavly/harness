// The log event catalogue of every workspace, derived from their constants files: no duplicate
// event, a well-formed name, a meaning of at least a sentence, and no event that is never used.
// A workspace that starts logging is covered by exporting `LOG_EVENT`; nothing is listed here.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { logEventProblems, readCatalogue, readCatalogues } from '../log-events.utils.js';
import { workspaceDirs } from '../rules/workspace-types.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const CATALOGUES = readCatalogues(workspaceDirs(REPO_ROOT));

describe('the repository’s catalogues', () => {
  it('are found in the workspaces that log, so the suite cannot pass by reading nothing', () => {
    const files = CATALOGUES.map(({ file }) => path.relative(REPO_ROOT, file));

    expect(files).toEqual(
      expect.arrayContaining([
        'apps/backend/src/logging/logging.constants.ts',
        'packages/storage/src/conversation-store/conversation-store.constants.ts',
      ]),
    );
  });

  it('hold no duplicate event, only well-formed names, a sentence of meaning each and no unused event', () => {
    expect(logEventProblems(CATALOGUES)).toEqual([]);
  });
});

/** A catalogue as a workspace would write it, used by `uses` (the text of another source file). */
function catalogue(params) {
  const { events, meanings, uses = Object.keys(events) } = params;
  const entries = (pairs) => Object.entries(pairs).map(([key, value]) => `  ${key}: '${value}',`);
  const text = [
    'export const LOG_EVENT = {',
    ...entries(events),
    '} as const;',
    'export const LOG_EVENT_MEANING = {',
    ...entries(meanings),
    '} satisfies Record<keyof typeof LOG_EVENT, string>;',
  ].join('\n');

  return {
    ...readCatalogue({ text, file: 'x.constants.ts' }),
    sources: new Map([
      ['x.helper.ts', uses.map((key) => `logger.error(LOG_EVENT.${key});`).join('\n')],
    ]),
  };
}

const MEANING = 'A request failed in a way the client is told only as internal.';

describe('the checks reject', () => {
  it('accepts a sound catalogue', () => {
    expect(
      logEventProblems([
        catalogue({ events: { A_FAILED: 'api.a_failed' }, meanings: { A_FAILED: MEANING } }),
      ]),
    ).toEqual([]);
  });

  it('an event value that two entries share', () => {
    const second = catalogue({
      events: { B_FAILED: 'api.a_failed' },
      meanings: { B_FAILED: MEANING },
    });
    const first = catalogue({
      events: { A_FAILED: 'api.a_failed' },
      meanings: { A_FAILED: MEANING },
    });

    expect(logEventProblems([first, second]).join('\n')).toContain(
      "'api.a_failed' is an event of more than one entry",
    );
  });

  it.each(['failed', 'Api.failed', 'api.Failed', 'api.failed.again', 'api-failed.x', 'api.'])(
    'the malformed name %s',
    (name) => {
      const problems = logEventProblems([
        catalogue({ events: { A_FAILED: name }, meanings: { A_FAILED: MEANING } }),
      ]);

      expect(problems.join('\n')).toContain('not a lowercase dotted');
    },
  );

  it('an event with no meaning, and a meaning with no event', () => {
    const problems = logEventProblems([
      catalogue({ events: { A_FAILED: 'api.a_failed' }, meanings: { OTHER: MEANING } }),
    ]).join('\n');

    expect(problems).toContain('A_FAILED has no LOG_EVENT_MEANING');
    expect(problems).toContain('LOG_EVENT_MEANING has OTHER');
  });

  it.each(['Failed.', 'A request failed', 'Too short to say much.'])(
    'a meaning that is not a sentence: %s',
    (meaning) => {
      const problems = logEventProblems([
        catalogue({ events: { A_FAILED: 'api.a_failed' }, meanings: { A_FAILED: meaning } }),
      ]);

      expect(problems.join('\n')).toContain('is not a sentence');
    },
  );

  it('an event nothing in its workspace uses', () => {
    const problems = logEventProblems([
      catalogue({
        events: { A_FAILED: 'api.a_failed' },
        meanings: { A_FAILED: MEANING },
        uses: [],
      }),
    ]);

    expect(problems.join('\n')).toContain('A_FAILED is never used');
  });
});
