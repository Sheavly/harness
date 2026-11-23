import { z } from 'zod';

/**
 * What reading a conversation's log needs of a line: its event and its stream `seq`, when it has
 * them. The rest of an entry is for a person with `jq`, so it is not checked here.
 */
export const logLineSchema = z.looseObject({
  event: z.string().exactOptional(),
  seq: z.number().int().nonnegative().exactOptional(),
});
