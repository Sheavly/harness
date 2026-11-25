import { z } from 'zod';
import { approvalResponseSchema } from '../approval/approval.validator.js';
import { extensionQualifiedNameSchema } from '../extension/extension.validator.js';
import { lowercaseUuidSchema } from '../id/id.validator.js';
import { clientHistoryMessageSchema, historyMessageSchema } from '../history/history.validator.js';
import { promptPartSchema } from '../message/message.validator.js';
import { adapterKindSchema, modelEffortSchema, modelIdSchema } from '../model/model.validator.js';
import { permissionModeSchema } from '../permission/permission.validator.js';
import { profileIdSchema } from '../profile/profile.validator.js';
import { sessionIdSchema } from '../session/session.validator.js';
import { skillInfoSchema } from '../skill/skill.validator.js';
import { timestampSchema } from '../time/time.validator.js';
import { contextUsageSchema, usageTotalsSchema } from '../usage/usage.validator.js';
import {
  MAX_IGNORED_SETTING_FILE_CHARS,
  MAX_IGNORED_SETTINGS,
  MAX_QUEUED_CHARS,
  MAX_QUEUED_LINE_CHARS,
} from './server.constants.js';

/**
 * A conversation's id on a server: a UUID in lowercase, which names its folder on disk and is
 * what every route calls it by (see `lowercaseUuidSchema` for why that shape). Branded, so it can't
 * be passed where a session's id goes (a conversation has one main session, but they aren't the
 * same); a plain string on the wire.
 */
export const conversationIdSchema = lowercaseUuidSchema.brand<'ConversationId'>();

/**
 * `POST /conversations`: start one, empty or continuing saved history. `workspace` is the folder
 * the agent works in (an absolute path to an existing folder; the backend's own when omitted) and
 * `profile` the models and keys it runs on (the profile its workspace is bound to when omitted,
 * else the default). Both are fixed for the conversation's life and kept with it.
 */
export const startConversationRequestSchema = z.object({
  messages: z.array(clientHistoryMessageSchema).exactOptional(),
  workspace: z.string().min(1).exactOptional(),
  profile: profileIdSchema.exactOptional(),
  /**
   * The model this conversation starts on: one of its profile's models, by id or by name (a unique
   * part of its name or model is enough). Left out, it starts on the profile's last one. It is for
   * this conversation only: unlike `PUT /conversations/:id/model` it is not remembered for the
   * profile's next one.
   */
  model: z.string().trim().min(1).max(200).exactOptional(),
  /**
   * The reasoning effort this conversation starts its model on, instead of the one the profile
   * remembers for it. For this conversation only: it is not remembered for the profile.
   */
  effort: modelEffortSchema.exactOptional(),
});

export const startConversationResponseSchema = z.object({ id: conversationIdSchema });

/**
 * A live conversation, as `GET /conversations` lists it: enough for another UI (an editor and an
 * agent window on one server) to find it and join. `session` is its main session, for a stream
 * filter; `running`, whether a prompt runs now.
 */
export const conversationSummarySchema = z.object({
  id: conversationIdSchema,
  title: z.string(),
  session: sessionIdSchema,
  running: z.boolean(),
  /** When it started. */
  startedAt: timestampSchema,
});

/** `GET /conversations`: every live conversation, oldest first. */
export const conversationsResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});

/**
 * A model a conversation can use. `id` is what names it, in a switch and everywhere else; `name`
 * is the label a UI shows (two models may share one), `adapter` its backend, `model` what that
 * backend calls it (the model or the deployment).
 */
export const modelChoiceSchema = z.object({
  id: modelIdSchema,
  name: z.string(),
  adapter: adapterKindSchema,
  model: z.string(),
  /** Older clients may omit it; the backend uses medium when no effort was selected. */
  effort: modelEffortSchema.exactOptional(),
});

/**
 * The folder a conversation's agents work from, when they chose one (a git worktree, usually):
 * its absolute path, and the branch checked out there (left out on a detached HEAD). A UI shows the
 * branch once instead of repeating the path.
 */
const workingRootSchema = z.object({
  root: z.string(),
  branch: z.string().exactOptional(),
});

/**
 * Something in a workspace's `.sheavly/settings.json` that did not apply, never with a value or
 * any of the file's text. With a `name`, that one entry was left out and `reason` is why:
 * `not-declared` (no installed extension declares it), `wrong-type`, `scope` (the setting may not
 * be set from a workspace) or `restricted` (the workspace is not trusted). Without a `name`, the
 * whole file was left out, or its trust could not be decided, and `reason` is the fixed cause:
 * `too-large`, `not-a-file`, `link` (it, or `.sheavly/`, is a link or leads outside), `not-utf8`,
 * `unreadable` (anything else, such as permissions), `not-json`, `bad-shape` (JSON, but not a
 * settings file) or `trust-unavailable` (the workspace's trust could not be checked, so it counts
 * as untrusted). `file` is the path of that file.
 */
export const ignoredSettingSchema = z.strictObject({
  layer: z.literal('workspace'),
  name: extensionQualifiedNameSchema.exactOptional(),
  file: z.string().max(MAX_IGNORED_SETTING_FILE_CHARS).exactOptional(),
  reason: z.enum([
    'not-declared',
    'wrong-type',
    'scope',
    'restricted',
    'too-large',
    'not-a-file',
    'link',
    'not-utf8',
    'unreadable',
    'not-json',
    'bad-shape',
    'trust-unavailable',
  ]),
});

/**
 * `GET /conversations/:id`: what the run is, for a UI's header. `model` is the one in use;
 * `models` what `PUT /model` can switch to (empty when there is only `model`). `projectTrust` is
 * whether the workspace's `.sheavly/` hooks run, and why not; `ignoredSettings` what the
 * workspace's settings file asked for that did not apply, present only when something did not,
 * at most `MAX_IGNORED_SETTINGS` of them, with `ignoredSettingsMore` counting the entries left
 * out of the list (present only when there were more); `permissionMode`, how `run_command` treats commands in this workspace right now (it can change
 * while the conversation runs, and applies to every conversation in the workspace).
 */
export const conversationDetailsSchema = conversationSummarySchema.extend({
  usage: usageTotalsSchema.exactOptional(),
  contextUsage: contextUsageSchema.exactOptional(),
  workspace: z.string(),
  /** The profile whose models and keys it runs on: fixed for the conversation's life. */
  profile: profileIdSchema,
  model: modelChoiceSchema,
  models: z.array(modelChoiceSchema),
  projectTrust: z.enum(['trusted', 'untrusted', 'changed', 'no_hooks']),
  ignoredSettings: z.array(ignoredSettingSchema).min(1).max(MAX_IGNORED_SETTINGS).exactOptional(),
  ignoredSettingsMore: z.int().min(1).exactOptional(),
  permissionMode: permissionModeSchema,
  /** Read each time, like `permissionMode`: the agents can choose another while it runs. */
  workingRoot: workingRootSchema.exactOptional(),
});

/**
 * `PUT /conversations/:id/model`: switch to the one of `models` with this `id`, from the next
 * model call on. A name is a label and never switches anything.
 */
export const switchModelRequestSchema = z.object({
  id: modelIdSchema,
  /** Omitted: restore the effort last used with this model in the profile. */
  effort: modelEffortSchema.exactOptional(),
});

/**
 * `POST /conversations/:id/prompts`: a prompt as `text` (a script; `/<name>`
 * mentions in it run those skills) or as `parts` (a UI; exactly the skills picked run).
 * One or the other.
 */
export const sendPromptRequestSchema = z.xor([
  z.object({ text: z.string().min(1) }),
  z.object({ parts: z.array(promptPartSchema).min(1) }),
]);

/**
 * `GET`/`PUT /conversations/:id/queue`: the lines waiting in a conversation's queue, oldest first.
 * Pending input is kept with the conversation so it survives a restart, but it is outside history,
 * model input and summaries until the conversation starts it as a prompt; reopening starts none.
 */
export const queuedPromptsSchema = z.object({
  queued: z
    .array(z.string().min(1).max(MAX_QUEUED_LINE_CHARS))
    .max(100)
    .refine((lines) => lines.reduce((total, line) => total + line.length, 0) <= MAX_QUEUED_CHARS, {
      message: `The queued lines may hold ${String(MAX_QUEUED_CHARS)} characters together`,
    }),
});

/**
 * `POST /conversations/:id/prompts`, answered at once: the prompt `started`, or it waits in the
 * conversation's queue (`queued`) and the conversation starts it when what runs now has ended.
 * `queued` is the queue after this request. What the prompt does arrives on the conversation's
 * stream, never in this answer.
 */
export const sendPromptResponseSchema = z.object({
  status: z.enum(['started', 'queued']),
  queued: queuedPromptsSchema.shape.queued,
});

/** `POST /conversations/:id/yield`: whether the active, non-stopping run accepted the request. */
export const yieldPromptResponseSchema = z.object({ accepted: z.boolean() });

/**
 * `QUERY /conversations/:id/stream`: which entries of the combined stream to send. Nothing: every
 * session's. `session`: one session's, with `subtree` its sub-agents' too. `replay`: from the
 * conversation's start first. `approvals`: this client answers approvals, so while it is
 * connected one waits for an answer; with no such client, an approval is refused at once.
 * `Last-Event-ID` resumes after an entry instead.
 */
export const streamQuerySchema = z.object({
  session: sessionIdSchema.exactOptional(),
  subtree: z.boolean().exactOptional(),
  replay: z.boolean().exactOptional(),
  approvals: z.boolean().exactOptional(),
});

/** `POST /conversations/:id/approvals/:approvalId`: the user's answer to a waiting approval. */
export const answerApprovalRequestSchema = z.object({ response: approvalResponseSchema });

/** `GET /conversations/:id/messages`: the history so far, valid to continue from. */
export const messagesResponseSchema = z.object({ messages: z.array(historyMessageSchema) });

/**
 * `QUERY /conversations/:id/skills`: which skills to list. Nothing: every one. `search`: those
 * whose name or description has it, ignoring case, as a UI's `/` menu narrows while the user types.
 */
export const skillsQuerySchema = z.object({ search: z.string().min(1).exactOptional() });

/** `QUERY /conversations/:id/skills`: the skills a prompt can run, for a UI's `/` menu. */
export const skillsResponseSchema = z.object({ skills: z.array(skillInfoSchema) });

/**
 * Why a request failed, one code per case a client handles differently. `internal` is the
 * server's own failure; every other code is the request's.
 */
export const serverErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'not_found',
  'session_running',
  /**
   * The conversation is busy and this prompt can't wait in its queue: it picks skills as `parts`,
   * it is longer than a queued line may be, or the queue is full.
   */
  'cannot_queue',
  /**
   * The conversation already serves as many subscriptions as it may. Nothing is wrong with the
   * request: the client asks again when one of them has ended.
   */
  'too_many_subscriptions',
  'unknown_skill',
  'unknown_approval',
  /**
   * A subscribe position the log cannot start at: a cursor past the end of the channel, or before
   * what it still holds. Never clamped to the nearest: the client asks again from `start` or a
   * snapshot. (A cursor that is not a cursor, or a tail over its bound, is `bad_request`.)
   */
  'cursor_out_of_range',
  /**
   * A command addressed to a node that has ended: cancelling or messaging one that is already
   * `completed`, `failed`, `cancelled` or `lost`. A node that does not exist is `not_found`.
   */
  'node_ended',
  'unknown_model',
  'storage_failed',
  /** No profile with a usable model yet: a UI onboards the user (profiles, models, keys) first. */
  'not_set_up',
  /** The backend refuses this here: a key may not be written over a network it is not safe on. */
  'forbidden',
  'internal',
]);

/** Every failed request's body: a code to branch on and a message to show. */
export const serverErrorSchema = z.object({
  error: z.object({ code: serverErrorCodeSchema, message: z.string() }),
});
