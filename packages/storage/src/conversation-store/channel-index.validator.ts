import { z } from 'zod';
import { MAX_ENTRY_TYPE_CHARS } from '@sheavly/protocol/channel/channel.constants';
import { cursorSchema } from '@sheavly/protocol/channel/cursor.validator';
import { MAX_NODE_ID_CHARS } from '@sheavly/protocol/node/node.constants';

/**
 * What a channel keeps in `<channel>.idx` beside its log: the log as it stood after one of its lines
 * (how many lines it held, how many bytes those are, where the last of them starts and what it was),
 * and where every `every`th line starts, so a process that reads the channel later checks the
 * last line and reads only the lines after, rather than every line. It is a cache: whatever is wrong
 * with it, the log is read whole and the index made again.
 *
 * It holds one offset for each block of `every` lines, the first at the start of the file, each
 * further on than the one before and all of them before the last line, which is before the end of
 * what it covers.
 */
export const channelIndexSchema = z
  .object({
    version: z.literal(1),
    every: z.number().int().positive(),
    size: z.number().int().positive(),
    count: z.number().int().positive(),
    lastOffset: z.number().int().nonnegative(),
    last: z.object({
      channel: z.string().min(1).max(MAX_NODE_ID_CHARS),
      cursor: cursorSchema,
      type: z.string().min(1).max(MAX_ENTRY_TYPE_CHARS),
    }),
    offsets: z.array(z.number().int().nonnegative()),
  })
  .refine(
    ({ every, count, offsets }) => offsets.length === Math.ceil(count / every) && offsets[0] === 0,
    { error: 'an index has an offset for each block of lines, the first at 0', path: ['offsets'] },
  )
  .refine(
    ({ size, lastOffset, offsets }) =>
      lastOffset < size &&
      offsets.every((offset, place) => offset <= lastOffset && offset > (offsets[place - 1] ?? -1)),
    { error: 'an index has each line further on than the one before', path: ['offsets'] },
  );
