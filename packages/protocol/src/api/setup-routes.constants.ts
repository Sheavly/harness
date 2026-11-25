import { keyCheckSchema } from '../model/model.validator.js';
import {
  adaptersResponseSchema,
  modelCatalogResponseSchema,
  modelsQuerySchema,
  modelsResponseSchema,
  profileSetupSchema,
  putCredentialRequestSchema,
  putModelRequestSchema,
  putProfileRequestSchema,
  setDefaultProfileRequestSchema,
  setupModelSchema,
  setupSchema,
} from '../setup/setup.validator.js';
import { terminalSettingsSchema } from '../terminal-settings/terminal-settings.validator.js';
import type { ApiRoute } from './api.types.js';

/**
 * The routes a setup UI calls, part of `API_ROUTES`: where the user's data is, the adapters and
 * the models on offer, the user-wide terminal preferences, and each profile with its models and
 * their credentials. None is about a conversation.
 */
export const SETUP_ROUTES = {
  getSetup: {
    effect: 'read',
    method: 'get',
    path: '/setup',
    summary: 'Where the user’s data is, the profiles with their models, and which is the default',
    response: { status: 200, schema: setupSchema },
  },
  listAdapters: {
    effect: 'read',
    method: 'get',
    path: '/adapters',
    summary: 'What each adapter needs, for a form that adds a model',
    response: { status: 200, schema: adaptersResponseSchema },
  },
  listModelCatalog: {
    effect: 'read',
    method: 'get',
    path: '/setup/models',
    summary: 'Models available to add and their supported hosting routes',
    response: { status: 200, schema: modelCatalogResponseSchema },
  },
  setTerminalSettings: {
    effect: 'change',
    method: 'put',
    path: '/terminal-settings',
    summary: 'Replace user-wide terminal preferences, shared by every profile',
    body: terminalSettingsSchema,
    response: { status: 204 },
  },
  getProfile: {
    effect: 'read',
    method: 'get',
    path: '/profiles/{profile}',
    summary: 'A profile with its models, whether their keys are set and whether it is ready',
    response: { status: 200, schema: profileSetupSchema },
  },
  putProfile: {
    effect: 'change',
    method: 'put',
    path: '/profiles/{profile}',
    summary: 'Make a profile under this id, or rename it',
    body: putProfileRequestSchema,
    response: { status: 204 },
  },
  deleteProfile: {
    effect: 'change',
    method: 'delete',
    path: '/profiles/{profile}',
    summary: 'Delete a profile with its models, keys and conversations',
    response: { status: 204 },
  },
  queryModels: {
    effect: 'read',
    method: 'query',
    path: '/profiles/{profile}/models',
    summary: 'A profile’s models with key state, or those a name, adapter or model search matches',
    body: modelsQuerySchema,
    response: { status: 200, schema: modelsResponseSchema },
  },
  getModel: {
    effect: 'read',
    method: 'get',
    path: '/profiles/{profile}/models/{model}',
    summary: 'One model of a profile, with whether its key is set and whether it is usable',
    response: { status: 200, schema: setupModelSchema },
  },
  putModel: {
    effect: 'change',
    method: 'put',
    path: '/profiles/{profile}/models/{model}',
    summary: 'Add a model to a profile, or replace it; checked by its adapter, never with a secret',
    body: putModelRequestSchema,
    response: { status: 204 },
  },
  deleteModel: {
    effect: 'change',
    method: 'delete',
    path: '/profiles/{profile}/models/{model}',
    summary: 'Remove a model and its key',
    response: { status: 204 },
  },
  putCredential: {
    effect: 'change',
    method: 'put',
    path: '/profiles/{profile}/credentials/{model}',
    summary: 'Set a model’s secrets, write-only; refused unless the backend listens on loopback',
    body: putCredentialRequestSchema,
    response: { status: 204 },
  },
  deleteCredential: {
    effect: 'change',
    method: 'delete',
    path: '/profiles/{profile}/credentials/{model}',
    summary: 'Forget a model’s secrets, keeping the model',
    response: { status: 204 },
  },
  checkCredential: {
    effect: 'change',
    method: 'post',
    path: '/profiles/{profile}/credentials/{model}/check',
    summary: 'Try the model with its stored key: one tiny call, answered with a fixed message',
    response: { status: 200, schema: keyCheckSchema },
  },
  setDefaultProfile: {
    effect: 'change',
    method: 'put',
    path: '/default-profile',
    summary: 'The profile conversations use where nothing else is chosen',
    body: setDefaultProfileRequestSchema,
    response: { status: 204 },
  },
} as const satisfies Record<string, ApiRoute>;
