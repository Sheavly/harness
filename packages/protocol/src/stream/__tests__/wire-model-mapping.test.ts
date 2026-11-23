import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approvalUpdateSchema } from '../../approval/approval.validator.js';
import { agentEventBodySchema } from '../../event/event.validator.js';
import { queueUpdateSchema } from '../../queue/queue.validator.js';
import { sessionUpdateSchema } from '../../session/session.validator.js';
import { taskUpdateSchema } from '../../task/task.validator.js';

const DOCS = join(import.meta.dirname, '../../../docs');
const MAPPING = join(DOCS, 'wire-model-mapping.md');
const WIRE_MODEL = join(DOCS, 'wire-model.md');

/** A union of objects tagged by `type`: the tags are the entry types the stream carries. */
type Tagged = { options: readonly { shape: { type: { value: string } } }[] };

function typesOf(schema: Tagged): string[] {
  return schema.options.map((option) => option.shape.type.value);
}

/** What the mapping page has to list, by the heading of the section that lists it. */
const SECTIONS: readonly { heading: string; types: string[] }[] = [
  { heading: 'Loop events', types: typesOf(agentEventBodySchema) },
  { heading: 'Session updates', types: typesOf(sessionUpdateSchema) },
  { heading: 'Task updates', types: typesOf(taskUpdateSchema) },
  { heading: 'Approval updates', types: typesOf(approvalUpdateSchema) },
  { heading: 'Queue updates', types: typesOf(queueUpdateSchema) },
];

/** The entry types a section's table names in its first column, in `backticks`. */
function listedIn(params: { page: string; heading: string }): string[] {
  const { page, heading } = params;
  const section = page.split(/^## /m).find((part) => part.startsWith(heading)) ?? '';

  return section
    .split('\n')
    .map((line) => /^\|\s*`([a-z_]+)`\s*\|/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe('the wire-model mapping page', () => {
  it.each(SECTIONS)(
    'lists every $heading type of the schemas once, and no type they no longer have (add or remove the row)',
    async ({ heading, types }) => {
      const page = await readFile(MAPPING, 'utf8');

      expect(listedIn({ page, heading }).toSorted()).toEqual(types.toSorted());
    },
  );

  it('says how many it maps in its headings and in the wire model page (update the counts)', async () => {
    const mapping = await readFile(MAPPING, 'utf8');
    const wireModel = await readFile(WIRE_MODEL, 'utf8');
    const counts = SECTIONS.map(({ heading, types }) => ({
      heading,
      count: types.length,
      stated: new RegExp(`^## ${heading} \\([^)]*?(\\d+)\\)`, 'm').exec(mapping)?.[1],
    }));
    const total = SECTIONS.reduce((sum, { types }) => sum + types.length, 0);

    expect(counts.map(({ heading, stated }) => ({ heading, stated }))).toEqual(
      counts.map(({ heading, count }) => ({ heading, stated: String(count) })),
    );
    expect(wireModel).toContain(`${String(total)} in all`);
  });
});
