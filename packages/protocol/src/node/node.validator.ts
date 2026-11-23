import { z } from 'zod';
import {
  extensionEnvelopeShape,
  extensionQualifiedNameSchema,
} from '../extension/extension.validator.js';
import { callIdSchema } from '../message/message.validator.js';
import { modelEffortSchema, modelIdSchema } from '../model/model.validator.js';
import { outputLogSchema } from '../output/output.validator.js';
import { runOutcomeSchema } from '../session/session.validator.js';
import { NODE_STATES } from '../status/status.constants.js';
import { timestampSchema } from '../time/time.validator.js';
import {
  BLANK_PATTERN,
  INCONSISTENT_NODE_MESSAGE,
  MAX_NODE_CALL_ID_CHARS,
  MAX_NODE_COMMAND_CHARS,
  MAX_NODE_DESCRIPTION_CHARS,
  MAX_NODE_ERROR_CHARS,
  MAX_NODE_ID_CHARS,
  MAX_NODE_OUTPUT_CHARS,
  MAX_NODE_REASON_CHARS,
  MAX_NODE_STATUS_CHARS,
  MAX_NODE_TITLE_CHARS,
  NODE_ID_PATTERN,
  RESERVED_EXTENSION_NAMES,
  SINGLE_LINE_PATTERN,
  TREE_CHANNEL_NAME,
} from './node.constants.js';
import { isConsistentNode, isReservedExtensionName } from './node.utils.js';

/**
 * A node's id, unique within its conversation. Branded, so it can't be passed where a session's,
 * task's or tool call's goes; it is still a plain string on the wire. It is never `tree`, the name
 * of the conversation's tree channel, since a node's channel is named by its id.
 */
export const nodeIdSchema = z
  .string()
  .max(MAX_NODE_ID_CHARS)
  .regex(NODE_ID_PATTERN, 'must be lowercase letters, digits, hyphens and underscores')
  .refine((id) => id !== TREE_CHANNEL_NAME, { error: 'is the name of the tree channel' })
  .brand<'NodeId'>();

/** Where a node is: its one lifecycle, whatever its kind. */
export const nodeStateSchema = z.enum(NODE_STATES);

/** What an extension or the harness sets as a node's title or status: one line, capped. */
const lineSchema = (max: number) =>
  z
    .string()
    .max(max)
    .regex(SINGLE_LINE_PATTERN, 'must be one line of plain text')
    .refine((text) => !BLANK_PATTERN.test(text), { error: 'must not be blank' });

/** What every node has, of any kind. The host owns the id, parent, state, times and link. */
const commonShape = {
  id: nodeIdSchema,
  /** The node that started this one: none for the root. */
  parent: nodeIdSchema.exactOptional(),
  title: lineSchema(MAX_NODE_TITLE_CHARS),
  state: nodeStateSchema,
  /** What the node says it is doing now (an agent's `report_status`): text, never a state. */
  status: lineSchema(MAX_NODE_STATUS_CHARS).exactOptional(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.exactOptional(),
  /** The tool call, in the parent's history, that started it. */
  spawnedBy: z.string().max(MAX_NODE_CALL_ID_CHARS).pipe(callIdSchema).exactOptional(),
};

/** The root agent or a sub-agent. */
const agentNodeSchema = z.object({
  ...commonShape,
  kind: z.literal('agent'),
  /** The model it runs on now. A node no model was recorded for has none. */
  modelId: modelIdSchema.exactOptional(),
  effort: modelEffortSchema.exactOptional(),
  /** How its last run ended: set once a run finishes, whether it went idle or ended. */
  lastOutcome: runOutcomeSchema.exactOptional(),
});

/** What a command and a service share: the work an extension or the harness started. */
const workShape = {
  ...commonShape,
  command: z.string().max(MAX_NODE_COMMAND_CHARS),
  description: z.string().max(MAX_NODE_DESCRIPTION_CHARS),
  /** Explicit `await_tasks` reason, absent until the node joins a delivery group. */
  reason: z.string().max(MAX_NODE_REASON_CHARS).exactOptional(),
  /** The most recent part of its output, bounded: the complete output is its channel's. */
  output: z.string().max(MAX_NODE_OUTPUT_CHARS),
  /** Where the complete output is kept, when it is captured. */
  outputLog: outputLogSchema.exactOptional(),
  exitCode: z.number().int().nullable().exactOptional(),
  error: z.string().max(MAX_NODE_ERROR_CHARS).exactOptional(),
};

const commandNodeSchema = z.object({ ...workShape, kind: z.literal('command') });

/** A service is never awaited and may outlive a run. */
const serviceNodeSchema = z.object({ ...workShape, kind: z.literal('service') });

/**
 * A kind an extension contributes: `<extension>.<name>`. A front end that does not know the kind
 * shows it from the common fields and `text`, and `data` is for one that does. `data` is JSON the
 * extension's own schema checked, capped as an extension event's is.
 */
const extensionNodeSchema = z.object({
  ...commonShape,
  kind: extensionQualifiedNameSchema.refine((kind) => !isReservedExtensionName(kind), {
    error: `its extension is one of ${RESERVED_EXTENSION_NAMES.join(', ')}, which are ours`,
  }),
  version: extensionEnvelopeShape.version,
  data: extensionEnvelopeShape.data,
  text: extensionEnvelopeShape.text,
});

/**
 * A unit of work in a conversation, as the tree channel and a snapshot carry it: the main agent, a
 * sub-agent, a command, a service or a kind an extension adds. `state`, `endedAt` and an agent's
 * `lastOutcome` do not contradict each other, and only an agent is idle (`isConsistentNode`); JSON
 * Schema cannot say so, so only parsing enforces it.
 */
export const nodeInfoSchema = z
  .union([
    z.discriminatedUnion('kind', [agentNodeSchema, commandNodeSchema, serviceNodeSchema]),
    extensionNodeSchema,
  ])
  .refine(isConsistentNode, { error: INCONSISTENT_NODE_MESSAGE, path: ['state'] });
