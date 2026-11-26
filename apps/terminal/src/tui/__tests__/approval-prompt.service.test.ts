import { describe, expect, it } from 'vitest';
import type { ApprovalOption, ApprovalRequest } from '@sheavly/protocol/approval/approval.types';
import { approvalIdSchema } from '@sheavly/protocol/approval/approval.validator';
import { callIdSchema } from '@sheavly/protocol/message/message.validator';
import { ApprovalPrompt } from '../approval-prompt.service.js';

const ALL: ApprovalOption[] = ['approve', 'always_allow', 'skip', 'skip_with_message'];

const request = (id: string, options: ApprovalOption[] = ALL): ApprovalRequest => ({
  id: approvalIdSchema.parse(id),
  callId: callIdSchema.parse('c1'),
  tool: 'run_command',
  command: `npm test ${id}`,
  concerns: [{ argument: 'npm test', reason: 'is not allowed yet' }],
  options,
});

const asking = (...ids: string[]) => {
  const prompt = new ApprovalPrompt();

  for (const id of ids) prompt.ask(request(id));

  return prompt;
};

const agent = { title: 'Helper' };

describe('ApprovalPrompt', () => {
  it('learns who asked from a repeat of a request, keeps it once, and drops it with the request', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1'));
    expect(prompt.currentAgent).toBeUndefined();

    prompt.ask(request('a1'), agent);
    expect(prompt.currentAgent).toBe(agent);
    expect(prompt.waiting).toBe(0);

    prompt.forget(approvalIdSchema.parse('a1'));
    prompt.ask(request('a1'));
    expect(prompt.currentAgent).toBeUndefined();
  });

  it('offers temporary and permanent scopes explicitly, without selecting either on arrival', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask({
      ...request('a1', ['approve', 'allow_session', 'always_allow', 'skip']),
      keeps: ['npx vitest run *'],
    });

    expect(prompt.confirm()).toEqual({ kind: 'none' });
    expect(prompt.choices.map(({ option }) => option)).toEqual([
      'approve',
      'allow_session',
      'always_allow',
      'skip',
    ]);
    expect(prompt.choices[1]?.hint).toContain('for every agent in this conversation, not saved');
    prompt.pickNumber(2);
    expect(prompt.confirm()).toEqual({
      kind: 'answer',
      answer: { id: 'a1', response: { decision: 'allow_session' } },
    });
  });

  it('shows the first request, and counts the ones waiting behind it', () => {
    const prompt = asking('a1', 'a2', 'a3');

    expect(prompt.current?.id).toBe('a1');
    expect(prompt.waiting).toBe(2);
    expect(new ApprovalPrompt().current).toBeUndefined();
    expect(new ApprovalPrompt().waiting).toBe(0);
  });

  it('keeps a request that is asked twice once, as a replay of the stream does', () => {
    const prompt = asking('a1', 'a1');

    expect(prompt.waiting).toBe(0);
  });

  it('lists the options a request offers, in the prompt’s order, with labels', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask(request('a1', ['skip', 'approve']));

    expect(prompt.choices.map(({ option }) => option)).toEqual(['approve', 'skip']);
    expect(prompt.choices[0]).toMatchObject({ option: 'approve', label: 'Run it once' });
  });

  it('says what always allow would keep, when the request says it, and a plain hint when not', () => {
    const prompt = new ApprovalPrompt();

    prompt.ask({ ...request('a1'), keeps: ['npm run test *'] });
    expect(prompt.choices.find(({ option }) => option === 'always_allow')?.hint).toBe(
      'keeps `npm run test *` allowed in this folder, for every agent',
    );

    prompt.forget(approvalIdSchema.parse('a1'));
    prompt.ask(request('a2'));
    expect(prompt.choices.find(({ option }) => option === 'always_allow')?.hint).toBe(
      'runs it, and keeps it allowed in this folder',
    );
  });

  describe('Enter never runs a command nobody chose', () => {
    it('picks nothing when a request is shown, so Enter does nothing', () => {
      const prompt = asking('a1');

      expect(prompt.picked).toBeUndefined();
      expect(prompt.confirm()).toEqual({ kind: 'none' });
      expect(prompt.current?.id).toBe('a1');
    });

    it('answers once a choice is picked by moving to it', () => {
      const prompt = asking('a1');

      prompt.move(1);
      expect(prompt.picked).toBe(0);
      expect(prompt.confirm()).toEqual({
        kind: 'answer',
        answer: { id: 'a1', response: { decision: 'approve' } },
      });
    });

    it('answers once a choice is picked by its number', () => {
      const prompt = asking('a1');

      prompt.pickNumber(2);

      expect(prompt.confirm()).toEqual({
        kind: 'answer',
        answer: { id: 'a1', response: { decision: 'always_allow' } },
      });
    });

    it('starts at the last choice when the first move is up', () => {
      const prompt = asking('a1');

      prompt.move(-1);

      expect(prompt.picked).toBe(3);
    });

    it('wraps around the end in both directions', () => {
      const prompt = asking('a1');

      prompt.pickNumber(4);
      prompt.move(1);
      expect(prompt.picked).toBe(0);
      prompt.move(-1);
      expect(prompt.picked).toBe(3);
    });

    it('ignores a number that is not a choice', () => {
      const prompt = asking('a1');

      prompt.pickNumber(0);
      prompt.pickNumber(5);

      expect(prompt.picked).toBeUndefined();
    });

    it('starts the next request with nothing picked, whatever was picked before', () => {
      const prompt = asking('a1', 'a2');

      prompt.pickNumber(1);
      prompt.confirm();

      expect(prompt.current?.id).toBe('a2');
      expect(prompt.picked).toBeUndefined();
      expect(prompt.confirm()).toEqual({ kind: 'none' });
    });
  });

  it('answers skip with the decision and takes the request off the queue', () => {
    const prompt = asking('a1', 'a2');

    prompt.pickNumber(3);

    expect(prompt.confirm()).toEqual({
      kind: 'answer',
      answer: { id: 'a1', response: { decision: 'skip' } },
    });
    expect(prompt.current?.id).toBe('a2');
    expect(prompt.waiting).toBe(0);
  });

  it('asks for the message before answering skip-with-a-message, and trims it', () => {
    const prompt = asking('a1');

    prompt.pickNumber(4);
    expect(prompt.confirm()).toEqual({ kind: 'needs_message' });
    expect(prompt.phase).toBe('message');
    expect(prompt.current?.id).toBe('a1');

    expect(prompt.skip('  use ls instead  ')).toEqual({
      kind: 'answer',
      answer: { id: 'a1', response: { decision: 'skip_with_message', message: 'use ls instead' } },
    });
    expect(prompt.phase).toBe('choose');
  });

  it('turns an empty message into a plain skip, which the protocol would refuse', () => {
    const prompt = asking('a1');

    expect(prompt.skip('   ')).toEqual({
      kind: 'answer',
      answer: { id: 'a1', response: { decision: 'skip' } },
    });
  });

  it('goes back from typing a message to choosing, keeping the request', () => {
    const prompt = asking('a1');

    prompt.pickNumber(4);
    prompt.confirm();
    prompt.cancelMessage();

    expect(prompt.phase).toBe('choose');
    expect(prompt.current?.id).toBe('a1');
  });

  it('does not move or pick while a message is being typed', () => {
    const prompt = asking('a1');

    prompt.pickNumber(4);
    prompt.confirm();
    prompt.move(1);
    prompt.pickNumber(1);

    expect(prompt.picked).toBe(3);
    expect(prompt.confirm()).toEqual({ kind: 'none' });
  });

  it('drops a request that was answered elsewhere, and moves to the next', () => {
    const prompt = asking('a1', 'a2');

    prompt.pickNumber(1);
    prompt.forget(approvalIdSchema.parse('a1'));

    expect(prompt.current?.id).toBe('a2');
    expect(prompt.picked).toBeUndefined();
  });

  it('keeps what is picked when a request behind the one shown is dropped', () => {
    const prompt = asking('a1', 'a2');

    prompt.pickNumber(2);
    prompt.forget(approvalIdSchema.parse('a2'));

    expect(prompt.current?.id).toBe('a1');
    expect(prompt.picked).toBe(1);
  });

  it('forgets a request it never had without trouble', () => {
    const prompt = asking('a1');

    prompt.forget(approvalIdSchema.parse('zzz'));

    expect(prompt.current?.id).toBe('a1');
  });

  it('empties when drained, returning what waited', () => {
    const prompt = asking('a1', 'a2');
    const drained = prompt.drain();

    expect(drained.map(({ id }) => id)).toEqual(['a1', 'a2']);
    expect(prompt.current).toBeUndefined();
    expect(prompt.picked).toBeUndefined();
  });

  it('skips the request shown with Esc, without a picked choice', () => {
    const prompt = asking('a1');

    expect(prompt.skip()).toEqual({
      kind: 'answer',
      answer: { id: 'a1', response: { decision: 'skip' } },
    });
    expect(new ApprovalPrompt().skip()).toEqual({ kind: 'none' });
  });
});
