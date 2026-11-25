import { contractDefinitions, contractName } from '../contract/contract.utils.js';
import { serverErrorSchema } from '../server/server.validator.js';
import { PROTOCOL_VERSION } from '../version/protocol-version.constants.js';
import {
  API_ROUTES,
  LAST_EVENT_ID_HEADER,
  OPENAPI_VERSION,
  ROUTE_TABLE_MARKERS,
  SCHEMAS,
} from './api.constants.js';
import type { ApiResponse, ApiRoute, OpenApiDocument } from './api.types.js';

/** A `$ref` to the contract's schema; a schema the contract doesn't name fails loudly. */
function refTo(schema: Parameters<typeof contractName>[0]): { $ref: string } {
  const name = contractName(schema);

  if (!name) throw new TypeError('An API route uses a schema the contract doesn’t name');

  return { $ref: `${SCHEMAS}${name}` };
}

/** A route's success answer in OpenAPI: JSON, nothing, or an SSE stream of items. */
function successOf(response: ApiResponse): Record<string, unknown> {
  if ('schema' in response) {
    return {
      description: 'Success',
      content: { 'application/json': { schema: refTo(response.schema) } },
    };
  }

  if ('stream' in response) {
    // OpenAPI 3.2's `itemSchema`: each SSE event's data is one item.
    return {
      description: 'Server-sent events: each frame’s data is one item',
      content: { 'text/event-stream': { itemSchema: refTo(response.stream) } },
    };
  }

  return { description: 'Done' };
}

/** The params of `route`: each `{param}` in its path, and `Last-Event-ID` for a stream that resumes with it. */
function parametersOf(route: ApiRoute): Record<string, unknown>[] {
  const names = [...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const pathParams = names.map((name) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));

  if (!('resumesWithLastEventId' in route.response)) return pathParams;

  return [
    ...pathParams,
    { name: LAST_EVENT_ID_HEADER, in: 'header', required: false, schema: { type: 'string' } },
  ];
}

/** One route as an OpenAPI operation: its params, body, success and the shared error. */
function operationOf(params: { operation: string; route: ApiRoute }): Record<string, unknown> {
  const { operation, route } = params;
  const error = {
    description: 'Refused: its `code` says why',
    content: { 'application/json': { schema: refTo(serverErrorSchema) } },
  };

  return {
    operationId: operation,
    summary: route.summary,
    // `security: []` lifts the document's bearer requirement for this operation alone.
    ...(route.public && { security: [] }),
    parameters: parametersOf(route),
    ...(route.body && {
      requestBody: {
        required: true,
        content: { 'application/json': { schema: refTo(route.body) } },
      },
    }),
    responses: { [String(route.response.status)]: successOf(route.response), default: error },
  };
}

/** What a route answers, as the route table in `docs/contract.md` says it. */
function answerCell(response: ApiResponse): string {
  if ('schema' in response) return `\`${contractName(response.schema) ?? '?'}\``;
  if ('stream' in response) return `\`${contractName(response.stream) ?? '?'}\`s (SSE)`;

  return `nothing (\`${response.status}\`)`;
}

/**
 * The route table of `docs/contract.md`, one row per `API_ROUTES` entry in definition order:
 * request, body schema and answer. `npm run schema -w @sheavly/protocol` writes it between the
 * doc's markers and a test holds the doc to it.
 */
function routeTableMarkdown(): string {
  const rows = Object.values(API_ROUTES).map((route: ApiRoute) => {
    const request = `\`${route.method.toUpperCase()} ${route.path}\``;
    const body = route.body ? `\`${contractName(route.body) ?? '?'}\`` : 'none';

    const token = route.public ? 'none' : 'bearer';

    return `| ${request} | ${token} | ${body} | ${answerCell(route.response)} |`;
  });

  return ['| Request | Token | Body | Answer |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/**
 * `markdown` with the block between the route table markers replaced by the current table, or
 * null when the markers are missing or out of order.
 */
export function withRouteTable(markdown: string): string | null {
  const { start, end } = ROUTE_TABLE_MARKERS;
  const from = markdown.indexOf(start);
  const to = markdown.indexOf(end);

  if (from === -1 || to < from) return null;

  const block = [start, '', routeTableMarkdown(), '', end].join('\n');

  return markdown.slice(0, from) + block + markdown.slice(to + end.length);
}

/**
 * The API as an OpenAPI 3.2 document, for clients and generators: every route, the bearer token
 * they all need except the `public` ones (`security: []`), and the contract's schemas as components.
 */
export function openApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};

  for (const [operation, route] of Object.entries(API_ROUTES)) {
    paths[route.path] = {
      ...paths[route.path],
      [route.method]: operationOf({ operation, route }),
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: { title: 'Sheavly harness', version: PROTOCOL_VERSION },
    paths,
    components: {
      schemas: contractDefinitions(SCHEMAS),
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearer: [] }],
  };
}
