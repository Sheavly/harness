import { LEGACY_QUEUE_MESSAGE_ID } from './legacy-effort.constants.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `value` with its old `mode` key named `effort`. A value that already has an `effort` keeps it, and
 * anything that is not an object, or has no `mode`, is returned as it is for the schema to judge.
 */
function renameModeToEffort(value: unknown): unknown {
  if (!isRecord(value) || !('mode' in value)) return value;

  const { mode, ...rest } = value;

  return { effort: mode, ...rest };
}

/**
 * A conversation's `index.json` as an older version wrote it (`mode`), read as the current one
 * (`effort`). The file is rewritten in the new form the next time the index is saved.
 */
export function readLegacyConversationIndex(input: unknown): unknown {
  return renameModeToEffort(input);
}

/**
 * A `queue` entry as an older version wrote it: a `prompt_started` or `prompt_refused` with no
 * message id, which a queued line had none of until it started. It is read with
 * `LEGACY_QUEUE_MESSAGE_ID`; an entry that has one (valid or not) is left for the schema to judge.
 */
function readLegacyQueueEntry(input: Record<string, unknown>): unknown {
  const { update } = input;

  if (!isRecord(update) || 'messageId' in update) return input;
  if (update.type !== 'prompt_started' && update.type !== 'prompt_refused') return input;

  return { ...input, update: { messageId: LEGACY_QUEUE_MESSAGE_ID, ...update } };
}

/**
 * A `stream.jsonl` entry as an older version wrote it, read as the current one: a session update's
 * `mode` (on `session_model`) and its session snapshot's `mode` are `effort`, and a queue entry's
 * line that started or was refused has the placeholder message id (`readLegacyQueueEntry`). Only
 * `update` and `queue` entries are touched, so a `mode` in an approval, a task or a tool's input
 * keeps its own meaning. The stream is append-only, so old lines stay as they are and are read this
 * way every time.
 */
export function readLegacyStreamEntry(input: unknown): unknown {
  if (isRecord(input) && input.kind === 'queue') return readLegacyQueueEntry(input);

  if (!isRecord(input) || input.kind !== 'update' || !isRecord(input.update)) return input;

  const { session, ...update } = input.update;
  const withSession = {
    ...update,
    ...(session !== undefined && { session: renameModeToEffort(session) }),
  };

  return { ...input, update: renameModeToEffort(withSession) };
}

/**
 * A `profile.json` as an older version wrote it, read as the current one: `modelModes` is
 * `modelEfforts`, and `lastModelSelection.mode` is `lastModelSelection.effort`. The file is
 * rewritten in the new form the next time the profile is saved.
 */
export function readLegacyProfile(input: unknown): unknown {
  if (!isRecord(input)) return input;

  const { modelModes, lastModelSelection, ...rest } = input;

  return {
    // Before `rest`, so a profile that somehow has both keys keeps the new one.
    ...(modelModes !== undefined && { modelEfforts: modelModes }),
    ...rest,
    ...(lastModelSelection !== undefined && {
      lastModelSelection: renameModeToEffort(lastModelSelection),
    }),
  };
}
