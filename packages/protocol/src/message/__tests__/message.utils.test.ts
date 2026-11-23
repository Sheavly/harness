import { describe, expect, it } from 'vitest';
import { skillNameSchema } from '../../skill/skill.validator.js';
import { partsText } from '../message.utils.js';

describe('partsText', () => {
  it('writes each picked skill as its mention, between the text around it', () => {
    const review = skillNameSchema.parse('review');

    expect(
      partsText([
        { type: 'skill', name: review },
        { type: 'text', text: ' the last commit' },
      ]),
    ).toBe('/review the last commit');
  });

  it('is the text itself for text alone', () => {
    expect(partsText([{ type: 'text', text: 'hi' }])).toBe('hi');
  });
});
