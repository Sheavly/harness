import { ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui';
import { createClient } from '@sheavly/client/client/client.helper';
import type { ModelId } from '@sheavly/protocol/model/model.types';
import type { Backend } from '../client/client.types.js';
import { SetupError } from '../errors/setup.errors.js';
import { SetupScreen } from './setup-screen.service.js';
import type { SetupUi } from './setup.types.js';
import { runSetupWizard } from './wizard.helper.js';

/**
 * Opens the wizard only for an unready workspace, or an explicit --setup request. It asks on the
 * terminal's setup screen, which needs an interactive terminal, unless the caller passes its own
 * `ui` (the questions of a test): then there is no terminal to need.
 */
export async function prepareSetup(params: {
  backend: Backend;
  workspace: string;
  interactive: boolean;
  force: boolean;
  ui?: SetupUi;
}): Promise<ModelId | undefined> {
  const { backend, workspace, interactive, force, ui } = params;
  const client = createClient(backend);
  const [setup, binding] = await Promise.all([
    client.call('getSetup', {}),
    client.call('queryWorkspaceProfile', { body: { workspace } }),
  ]);
  const profile = setup.profiles.find(({ id }) => id === binding.profile);

  if (profile?.ready && !force) return undefined;

  if (ui) return runSetupWizard({ client, ui, workspace, setup });

  if (!interactive) {
    throw new SetupError(
      'Setup needs an interactive terminal. Run `sheavly setup` (or `sheavly chat --setup`) in a terminal first.',
    );
  }

  const screen = new SetupScreen(new TuiMainScreen(new ProcessTerminal()));

  screen.start();

  try {
    return await runSetupWizard({ client, ui: screen, workspace, setup });
  } finally {
    screen.stop();
  }
}
