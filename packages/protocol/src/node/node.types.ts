import type { z } from 'zod';
import type { nodeIdSchema } from './node.validator.js';

/** A node's id, unique within its conversation. */
export type NodeId = z.infer<typeof nodeIdSchema>;
