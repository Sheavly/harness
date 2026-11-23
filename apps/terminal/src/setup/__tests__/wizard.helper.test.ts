import { describe, expect, it } from 'vitest';
import { modelIdSchema } from '@sheavly/protocol/model/model.validator';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import type { AdapterDescription } from '@sheavly/protocol/model/model.types';
import type { ProfileSetup } from '@sheavly/protocol/setup/setup.types';
import { fakeSetupBackend, setupAnswers } from '../../testing/setup.fake.js';
import { runSetupWizard } from '../wizard.helper.js';
import { prepareSetup } from '../setup.helper.js';

const profile = profileIdSchema.parse('11111111-1111-4111-8111-111111111111');
const model = modelIdSchema.parse('22222222-2222-4222-8222-222222222222');

function readyWorkProfile(): ProfileSetup {
  return {
    id: profile,
    name: 'Work',
    ready: true,
    models: [
      {
        id: model,
        name: 'Selected',
        adapter: 'setup-test',
        definition: {},
        credential: 'set',
        usable: true,
      },
    ],
  };
}

describe('terminal setup over the API', () => {
  it('changes global terminal settings before profile selection without touching profiles or models', async () => {
    const backend = fakeSetupBackend();

    backend.state.profiles.push(readyWorkProfile());
    backend.state.terminal = { reducedMotion: true };
    const { ui } = setupAnswers({
      choices: [
        'terminal-settings',
        'animated',
        'on',
        'terminal-settings',
        'reduced',
        'off',
        profile,
        model,
        'start',
      ],
      text: [],
    });
    const initialChoices: (string | undefined)[] = [];
    const choose = ui.choose;

    ui.choose = (question) => {
      if (question.title === 'Terminal motion' || question.title === 'Terminal bell') {
        initialChoices.push(question.initial);
      }

      return choose(question);
    };

    await runSetupWizard({ ...backend, ui, workspace: '/workspace', setup: backend.state });

    expect(initialChoices).toEqual(['reduced', 'off', 'animated', 'on']);
    expect(backend.state.terminal).toEqual({ reducedMotion: true, bell: false });
    expect(
      backend.calls.filter(({ name }) => name.startsWith('put')).map(({ name }) => name),
    ).toEqual([]);
    expect(backend.calls.find(({ name }) => name === 'setTerminalSettings')).toMatchObject({
      call: { body: { reducedMotion: false, bell: true } },
    });
  });

  it('creates an ID-keyed profile and model, sends a masked key separately, binds and makes it default', async () => {
    const backend = fakeSetupBackend();
    const { ui, secrets, notices } = setupAnswers({
      choices: [
        'terminal-settings',
        'reduced',
        'off',
        'new',
        'new',
        'custom',
        'setup-test',
        '300000',
        'start',
      ],
      text: [
        'Work',
        'remote-deployment',
        'remote-deployment',
        'https://example.test',
        '2048',
        'private-key',
      ],
    });
    const id = await runSetupWizard({
      ...backend,
      ui,
      workspace: '/workspace',
      setup: backend.state,
    });
    const saved = backend.state.profiles[0];

    expect(saved?.models).toEqual([
      {
        id,
        name: 'remote-deployment',
        identity: { model: 'remote-deployment' },
        contextWindow: 300_000,
        adapter: 'setup-test',
        credential: 'set',
        usable: true,
        definition: {
          deployment: 'remote-deployment',
          endpoint: 'https://example.test',
          limit: 2048,
          reasoning: true,
        },
      },
    ]);
    expect(backend.state.defaultProfile).toBe(saved?.id);
    expect(backend.state.terminal).toEqual({ reducedMotion: true, bell: false });
    expect(secrets).toEqual(['API key']);
    expect(JSON.stringify(backend.state)).not.toContain('private-key');
    expect(notices.join('\n')).not.toContain('private-key');
    expect(backend.calls.filter(({ name }) => name === 'putCredential')).toMatchObject([
      { call: { body: { secrets: { password: 'private-key' } } } },
    ]);
    expect(backend.calls.map(({ name }) => name)).not.toContain('checkCredential');
    expect(backend.calls.at(-2)).toMatchObject({
      name: 'bindWorkspace',
      call: { body: { workspace: '/workspace', profile: saved?.id } },
    });
  });

  it('uses an existing model without rewriting it or its key, and leaves an existing default alone', async () => {
    const backend = fakeSetupBackend();

    backend.state.defaultProfile = profileIdSchema.parse('33333333-3333-4333-8333-333333333333');
    backend.state.profiles.push(readyWorkProfile());
    const { ui } = setupAnswers({ choices: [profile, model, 'start'], text: [] });

    await expect(
      runSetupWizard({ ...backend, ui, workspace: '/workspace', setup: backend.state }),
    ).resolves.toBe(model);
    expect(
      backend.calls.filter(({ name }) => name.startsWith('put') || name === 'setDefaultProfile'),
    ).toEqual([]);
    expect(backend.calls.at(-1)?.name).toBe('bindWorkspace');
  });

  it.each([
    { current: 1_000_000, picked: '1000000', saved: 1_000_000, labels: ['300K', '1M'] },
    { current: 1_000_000, picked: '300000', saved: 300_000, labels: ['300K', '1M'] },
    { current: 300_000, picked: '1000000', saved: 1_000_000, labels: ['300K', '1M'] },
    // A size a host gave the model is shown by its exact count, and kept unless it is changed.
    {
      current: 128_000,
      picked: '128000',
      saved: 128_000,
      labels: ['128,000 tokens', '300K', '1M'],
    },
  ])(
    'offers "300K" and "1M" when a model is edited, starts on its size $current and saves $saved',
    async ({ current, picked, saved, labels }) => {
      const backend = fakeSetupBackend();
      const setup = readyWorkProfile();

      backend.state.profiles.push({
        ...setup,
        models: setup.models.map((item) => ({ ...item, contextWindow: current })),
      });
      const { ui } = setupAnswers({
        // The fake backend forgets the key when a model is rewritten, so the user sets it again.
        choices: [profile, model, 'edit', picked, 'true', 'key', 'start'],
        text: ['Selected', 'remote-deployment', 'https://example.test', '2048', 'private-key'],
      });
      const asked: { labels: string[]; initial: string | undefined }[] = [];
      const choose = ui.choose;

      ui.choose = (question) => {
        if (question.title.startsWith('Context size')) {
          asked.push({
            labels: question.items.map((item) => item.label),
            initial: question.initial,
          });
        }

        return choose(question);
      };

      await runSetupWizard({ ...backend, ui, workspace: '/workspace', setup: backend.state });

      expect(asked).toEqual([{ labels, initial: String(current) }]);
      expect(backend.calls.filter(({ name }) => name === 'putModel')).toMatchObject([
        { call: { body: { contextWindow: saved } } },
      ]);
    },
  );

  it('repairs missing credentials and lets a failed connection check return to key entry', async () => {
    const backend = fakeSetupBackend();

    backend.state.profiles.push({
      id: profile,
      name: 'Work',
      ready: false,
      models: [
        {
          id: model,
          name: 'Needs key',
          adapter: 'setup-test',
          definition: {},
          credential: 'missing',
          usable: false,
        },
      ],
    });
    const { ui, notices } = setupAnswers({
      choices: [profile, model, 'key', 'check', 'key', 'start'],
      text: ['bad-key', 'replacement-key'],
    });

    await runSetupWizard({ ...backend, ui, workspace: '/workspace', setup: backend.state });
    expect(notices).toContain('The key was refused.');
    expect(backend.calls.filter(({ name }) => name === 'putCredential')).toHaveLength(2);
    expect(backend.calls.filter(({ name }) => name === 'putModel')).toHaveLength(0);
  });

  describe('editing a model that signs in one of two ways', () => {
    const secret = (title: string, appliesWhen: Record<string, string>) => ({
      type: 'string',
      secret: true,
      title,
      appliesWhen,
    });
    const twoWays: AdapterDescription = {
      kind: 'two-ways',
      description: 'Signs in one of two ways',
      secrets: ['apiKey', 'accessKey'],
      remoteField: 'deployment',
      config: {
        type: 'object',
        required: ['auth', 'deployment'],
        properties: {
          auth: { type: 'string', enum: ['api-key', 'access-key'], title: 'Credentials' },
          deployment: { type: 'string', title: 'Deployment' },
          apiKey: secret('API key', { auth: 'api-key' }),
          accessKey: secret('Access key', { auth: 'access-key' }),
        },
      },
    };

    /** Edits the model (signing in with an API key) to sign in `to`, answering `secrets` if asked. */
    async function edit(params: { to: string; secrets: string[] }) {
      const backend = fakeSetupBackend({ adapters: [twoWays], keepsKeyOnRewrite: true });

      backend.state.profiles.push({
        id: profile,
        name: 'Work',
        ready: true,
        models: [
          {
            id: model,
            name: 'Selected',
            adapter: 'two-ways',
            definition: { auth: 'api-key', deployment: 'd' },
            credential: 'set',
            usable: true,
          },
        ],
      });
      const answers = setupAnswers({
        choices: [profile, model, 'edit', '300000', params.to, 'start'],
        text: ['Selected', 'd', ...params.secrets],
      });

      await runSetupWizard({
        ...backend,
        ui: answers.ui,
        workspace: '/workspace',
        setup: backend.state,
      });

      return { backend, ...answers };
    }

    it('asks for the secrets of the new way, hidden, and sends them to replace the old way’s', async () => {
      const { backend, questions, secrets, notices } = await edit({
        to: 'access-key',
        secrets: ['new-secret'],
      });

      expect(notices).toContain(
        'How this model signs in changed, so its secrets are asked for again.',
      );
      expect(secrets).toEqual(['Access key']);
      expect(questions).not.toContain('API key');
      expect(backend.calls.filter(({ name }) => name === 'putCredential')).toMatchObject([
        { call: { body: { secrets: { accessKey: 'new-secret' } } } },
      ]);
    });

    it('asks for nothing, and sends nothing, when how it signs in is unchanged', async () => {
      // No secret answer is given: a question for one would fail the test.
      const { backend, secrets, notices } = await edit({ to: 'api-key', secrets: [] });

      expect(secrets).toEqual([]);
      expect(notices.join('\n')).not.toContain('signs in changed');
      expect(backend.calls.filter(({ name }) => name === 'putCredential')).toEqual([]);
    });
  });

  it('does not prompt or write for a ready workspace in plain mode', async () => {
    const backend = fakeSetupBackend();

    backend.state.defaultProfile = profile;
    backend.state.profiles.push({ id: profile, name: 'Ready', ready: true, models: [] });
    await expect(
      prepareSetup({
        backend: backend.backend,
        workspace: '/workspace',
        interactive: false,
        force: false,
      }),
    ).resolves.toBeUndefined();
    expect(backend.calls.map(({ name }) => name).sort()).toEqual([
      'getSetup',
      'queryWorkspaceProfile',
    ]);
  });

  it('asks through the ui it is given when forced, with no terminal, and ends with a closing notice that opens nothing', async () => {
    const backend = fakeSetupBackend();

    backend.state.defaultProfile = profile;
    backend.state.profiles.push(readyWorkProfile());
    // A ready workspace is set up again only because setup was asked for.
    const { ui, notices, questions } = setupAnswers({
      choices: ['terminal-settings', 'reduced', 'off', profile, model, 'start'],
      text: [],
    });

    await prepareSetup({
      backend: backend.backend,
      workspace: '/workspace',
      interactive: false,
      force: true,
      ui,
    });

    expect(questions).toContain('Choose a model');
    expect(notices.at(-1)).toBe('Setup complete.');
  });

  it('asks nothing of a ready workspace that setup was not asked for, even with a ui', async () => {
    const backend = fakeSetupBackend();

    backend.state.defaultProfile = profile;
    backend.state.profiles.push(readyWorkProfile());

    const { ui, questions } = setupAnswers({ choices: [], text: [] });

    await prepareSetup({
      backend: backend.backend,
      workspace: '/workspace',
      interactive: false,
      force: false,
      ui,
    });

    expect(questions).toEqual([]);
  });

  it('explains how to set up without consuming piped prompts, naming the command that does it', async () => {
    const backend = fakeSetupBackend();

    await expect(
      prepareSetup({
        backend: backend.backend,
        workspace: '/workspace',
        interactive: false,
        force: false,
      }),
    ).rejects.toThrow('Run `sheavly setup` (or `sheavly chat --setup`) in a terminal first.');
    expect(backend.calls).toHaveLength(2);
  });
});
