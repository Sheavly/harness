import type { z } from 'zod';
import type { modelConnectionSchema } from './connection.validator.js';

export type ModelConnection = z.infer<typeof modelConnectionSchema>;
