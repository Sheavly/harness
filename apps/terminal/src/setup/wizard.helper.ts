import { randomUUID } from 'node:crypto';
import type { ModelId } from '@sheavly/protocol/model/model.types';
import { profileIdSchema } from '@sheavly/protocol/profile/profile.validator';
import type { Setup } from '@sheavly/protocol/setup/setup.types';
import { configureModel } from './model.helper.js';
import { chooseSetupProfile } from './terminal-settings.helper.js';
import type { SetupClient, SetupUi } from './setup.types.js';

/** Uses only setup routes. Existing profiles and keys are never read from local config files. */
export async function runSetupWizard(params: {
  client: SetupClient;
  ui: SetupUi;
  workspace: string;
  setup: Setup;
}): Promise<ModelId> {
  const { client, ui, workspace, setup } = params;

  if (setup.problems.length) ui.notice(setup.problems.join('\n'));

  const picked = await chooseSetupProfile({ client, ui, setup });
  const profile =
    picked === 'new' ? profileIdSchema.parse(randomUUID()) : profileIdSchema.parse(picked);

  if (picked === 'new') {
    const name = await ui.text({
      title: 'Profile name',
      initial: 'Personal',
      validate: (value) =>
        value.length > 0 && value.length <= 80 ? undefined : 'Use 1 to 80 characters.',
    });

    await client.send('putProfile', { profile, body: { name }, signal: ui.signal });
  }

  const current = await client.call('getProfile', { profile, signal: ui.signal });
  const selection = await ui.choose({
    title: 'Choose a model',
    items: [
      ...current.models.map(({ id, name, adapter, credential }) => ({
        value: id,
        label: name,
        description: `${adapter} · ${credential} · ${id}`,
      })),
      { value: 'new', label: 'Add a model' },
    ],
  });
  const existing = current.models.find(({ id }) => id === selection);
  const model = await configureModel({ client, ui, profile, ...(existing && { existing }) });

  // Bind this workspace explicitly: changing the default alone cannot replace an existing binding.
  await client.send('bindWorkspace', { body: { workspace, profile }, signal: ui.signal });

  if (!setup.defaultProfile) {
    await client.send('setDefaultProfile', { body: { profile }, signal: ui.signal });
  }

  ui.notice('Setup complete.');

  return model;
}
