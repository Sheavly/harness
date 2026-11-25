import { describe, expect, it } from 'vitest';
import { BASE_AGENT_INSTRUCTIONS } from '../instructions.prompt.js';
import { composeInstructions } from '../instructions.helper.js';
import { createHarness } from '../../host/host.helper.js';
import { scriptedProvider } from '@sheavly/testing/provider/scripted-provider.fake';

describe('shared instructions', () => {
  it('uses a domain-neutral default without named tools or coding assumptions', () => {
    const harness = createHarness({ provider: scriptedProvider([]), title: 'Extract text' });

    expect(harness.instructions).toBe(BASE_AGENT_INSTRUCTIONS);
    expect(harness.instructions).not.toMatch(
      /coding agent|workspace|report_status|run_command|task_status/,
    );
    expect(harness.instructions.trim().split(/\s+/).length).toBeLessThanOrEqual(300);
    expect(harness.instructions).toContain('read-only, plan-only and no-execution limits');
    expect(harness.instructions).toContain("do not expand the user's authorization");
  });

  it('makes yielding rather than status polling part of the system instructions', () => {
    const instructions = composeInstructions({ instructions: 'Extract the result.' });

    expect(instructions).toContain(
      'Finished finite background work wakes you, so never call a tool to wait',
    );
    expect(instructions).toContain('end your turn without tool calls');
    expect(instructions).toContain('Inspect status only for requested updates or diagnosis');
    expect(instructions.match(/end your turn without tool calls/g)).toHaveLength(1);
  });

  it('keeps tool selection and delegation policy independent of tool mechanics', () => {
    const instructions = composeInstructions({});

    expect(instructions).toContain('Prefer dedicated tools over shell commands for file work');
    expect(instructions).toContain('Read relevant files before editing');
    expect(instructions).toContain('Delegate self-contained work when useful');
    expect(instructions).not.toMatch(/read_file|edit_file|start_agent|oldText|inputSchema/);
  });

  it('requires commit authorization and inspection without bypassing safeguards', () => {
    const instructions = composeInstructions({});

    expect(instructions).toContain('Create commits only when explicitly asked');
    expect(instructions).toContain('inspect status, diff and recent history');
    expect(instructions).toContain('stage only intended files and verify the result');
    expect(instructions).toContain('Never change git configuration or bypass hooks');
    expect(instructions).toContain(
      'Do not run destructive operations or rewrite history without explicit authorization',
    );
  });

  it('requires full-branch PR preparation without inferring publication permission', () => {
    const instructions = composeInstructions({});

    expect(instructions).toContain('Use gh for GitHub operations when available');
    expect(instructions).toContain(
      'inspect status, the branch diff, remote tracking and commit history against its intended base',
    );
    expect(instructions).toContain('summarize the full change');
    expect(instructions).toContain(
      'Permission to edit or commit does not authorize pushing, opening or updating pull requests, or changing issues',
    );
    expect(instructions).not.toMatch(/Refs:|Closes #|area\/|Bugbot|force-with-lease|HEREDOC/);
  });

  it('appends host extras once, separated by a blank line', () => {
    expect(composeInstructions({ instructions: '  HOST EXTRAS\n' })).toBe(
      `${BASE_AGENT_INSTRUCTIONS}\n\nHOST EXTRAS`,
    );
  });

  it('replaces the core without removing extras', () => {
    expect(composeInstructions({ baseInstructions: 'CUSTOM', instructions: 'EXTRAS' })).toBe(
      'CUSTOM\n\nEXTRAS',
    );
  });

  it('distinguishes an absent base from an explicitly empty one', () => {
    expect(composeInstructions({ baseInstructions: undefined })).toBe(BASE_AGENT_INSTRUCTIONS);
    expect(composeInstructions({ baseInstructions: '', instructions: 'EXTRAS' })).toBe('EXTRAS');
    expect(composeInstructions({ baseInstructions: '', instructions: ' \n ' })).toBe('');
  });
});
