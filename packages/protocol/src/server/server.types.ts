import type { z } from 'zod';
import type {
  conversationDetailsSchema,
  conversationIdSchema,
  conversationSummarySchema,
  ignoredSettingSchema,
  modelChoiceSchema,
  sendPromptRequestSchema,
  serverErrorCodeSchema,
  serverErrorSchema,
} from './server.validator.js';

// Each route's request and answer types come from its schemas in `API_ROUTES`
// (`@sheavly/protocol/api/`): the client and the backend read them there, by route.

/** A conversation's id on a server; not a session's id. */
export type ConversationId = z.infer<typeof conversationIdSchema>;

/** A live conversation, as another UI finds it to join. */
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/** A workspace settings entry, or the whole file, that did not apply; never carries a value. */
export type IgnoredSettingReport = z.infer<typeof ignoredSettingSchema>;

/** A model a conversation can use. */
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

/** What a conversation's run is: workspace, model and the choices, trust, the permission mode. */
export type ConversationDetails = z.infer<typeof conversationDetailsSchema>;

/** What the user typed: `text` (`/<name>` mentions run skills) or `parts` (exactly those skills). */
export type SendPromptRequest = z.infer<typeof sendPromptRequestSchema>;

/** Why a request failed: one code per case a client handles differently. */
export type ServerErrorCode = z.infer<typeof serverErrorCodeSchema>;

/** Every failed request's body. */
export type ServerError = z.infer<typeof serverErrorSchema>;
