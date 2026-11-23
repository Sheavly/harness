import type { ConversationDetails } from '@sheavly/protocol/server/server.types';
import type { ModelId } from '@sheavly/protocol/model/model.types';
import { conversationIdSchema } from '@sheavly/protocol/server/server.validator';
import { BackendError } from '../errors/backend.errors.js';
import { profileArgs } from './profile-args.utils.js';
import { describeProfile, settleProfile } from './session-profile.helper.js';
import { Renderer } from '../render/render.service.js';
import { projectTrustNotice } from '../render/render.utils.js';
import { connectBackend } from './backend.helper.js';
import type { Backend, FoundBackend } from './client.types.js';
import { openConversation } from './conversation.helper.js';
import type { RemoteConversation } from './conversation.service.js';
import { trustFolderOnAttached } from './trust-attached.helper.js';

/**
 * A terminal CLI's conversation, as the chat and the demo open it: the backend (started with
 * `env` and `--trust` from `args`, its output written as it comes), a new conversation on it, its
 * details and a renderer. A backend that was already running (`BACKEND_URL`, or a `server` the
 * caller found) gets `--trust` sent to it for this terminal's folder before the conversation opens,
 * and that same folder is the conversation's workspace (`trustFolderOnAttached`). `prompt` is the
 * rest of `args`.
 * Prints what the run is: the model, the workspace, the permission mode and why `.sheavly/` hooks
 * didn't load.
 */
export async function openSession(params: {
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  write: (text: string) => void;
  workspace?: string;
  /** Aborting while the backend starts stops it and rejects: Ctrl+C before a conversation exists. */
  signal?: AbortSignal;
  /** A chat may configure the backend before opening its first conversation. */
  prepare?: (backend: Backend) => Promise<ModelId | undefined>;
  /** A backend the caller found: used instead of `BACKEND_URL` or starting one. */
  server?: FoundBackend;
}): Promise<{
  backend: Backend;
  conversation: RemoteConversation;
  details: ConversationDetails;
  renderer: Renderer;
  prompt: string;
}> {
  const { env, args, write } = params;
  const resume = resumeArgs(args);
  const chosen = profileArgs(resume.args);
  const backend = params.server
    ? attachedTo(params.server)
    : await connectBackend({
        env,
        args: args.filter((arg) => arg === '--trust'),
        onOutput: write,
        ...(params.signal && { signal: params.signal }),
      });
  let conversation: RemoteConversation | undefined;

  try {
    // Before anything opens: a backend that was already running never got this run's `--trust`.
    const workspace = await trustFolderOnAttached({
      backend,
      args,
      workspace: params.workspace,
      env,
      write,
    });

    const profile = await settleProfile({
      backend,
      resume: resume.id,
      requested: chosen.profile,
      write,
    });
    // A named profile is used as it is: setup would judge, and bind, another one.
    const model = profile ? undefined : await params.prepare?.(backend);

    conversation = await openConversation({
      backend,
      resume: resume.id,
      workspace,
      profile,
    });

    if (!resume.id && model && !(await conversation.useModel(model))) {
      throw new BackendError({
        message: 'The selected model is no longer available. Run with --setup again.',
      });
    }

    return await describeSession({ backend, conversation, args: chosen.args, write });
  } catch (caughtError) {
    await closeSession({ backend, conversation });
    throw caughtError;
  }
}

/**
 * The one way a terminal entry point ends a session: closes the conversation (it stops what the
 * conversation started), then stops the backend even when closing fails. A caller with two ways to
 * end (the normal one and a force quit) keeps the promise and calls this once.
 */
export async function closeSession(params: {
  backend: Backend;
  conversation: RemoteConversation | undefined;
}): Promise<void> {
  try {
    await params.conversation?.close();
  } finally {
    await params.backend.stop();
  }
}

/** A found backend as the terminal holds one it only connected to: nothing to stop on the way out. */
export function attachedTo(server: FoundBackend): Backend {
  return { url: server.url, token: server.token, attached: true, stop: async () => undefined };
}

function resumeArgs(args: readonly string[]) {
  const index = args.indexOf('--resume');

  if (index === -1) return { id: undefined, args };

  const parsed = conversationIdSchema.safeParse(args[index + 1]);

  if (!parsed.success) {
    throw new BackendError({ message: '--resume requires a conversation id (a lowercase UUID)' });
  }

  return {
    id: parsed.data,
    args: args.filter((_, position) => position !== index && position !== index + 1),
  };
}

async function describeSession(params: {
  backend: Backend;
  conversation: RemoteConversation;
  args: readonly string[];
  write: (text: string) => void;
}) {
  const { backend, conversation, args, write } = params;
  const details = await conversation.details();

  write(`→ conversation ${conversation.id} (reopen with --resume)\n`);
  write(`→ profile ${await describeProfile({ backend, profile: details.profile })}\n`);
  write(`→ ${details.model.adapter} / ${details.model.model} in ${details.workspace}\n`);

  if (details.permissionMode === 'allow_all') {
    write('⚠ run_command is on allow all: any command can run without asking\n');
  }

  const trustNotice = projectTrustNotice(details.projectTrust);

  if (trustNotice) write(`${trustNotice}\n`);

  return {
    backend,
    conversation,
    details,
    renderer: new Renderer(write),
    prompt: args.filter((arg) => arg !== '--trust').join(' '),
  };
}
