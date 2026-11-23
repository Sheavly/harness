import { MAX_NODE_OUTPUT_CHARS } from '@sheavly/protocol/node/node.constants';
import { describe, expect, it } from 'vitest';
import { MAX_TASK_OUTPUT_CHARS } from '../tasks.constants.js';

describe('the output a node carries', () => {
  it('is capped at what the task registry keeps, so a preview always fits a node', () => {
    // The protocol cannot import the runtime, so the two numbers are held together here.
    expect(MAX_NODE_OUTPUT_CHARS).toBe(MAX_TASK_OUTPUT_CHARS);
  });
});
