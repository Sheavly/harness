import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_ROUTES, OPENAPI_FILE, ROUTE_TABLE_DOC } from '../api.constants.js';
import { openApiDocument, withRouteTable } from '../api.utils.js';
import { refsIn } from '../../testing/refs.fake.js';

const PACKAGE_ROOT = join(import.meta.dirname, '../../..');

describe('the route table in docs/contract.md', () => {
  it('is generated from API_ROUTES (rerun `npm run schema -w @sheavly/protocol`)', async () => {
    const markdown = await readFile(join(PACKAGE_ROOT, ROUTE_TABLE_DOC), 'utf8');
    const generated = withRouteTable(markdown);

    expect(generated).not.toBeNull();
    // Prettier pads the written table, so compare cells, not spacing.
    const cells = (text: string | null) =>
      (text ?? '').replaceAll(/[ \t]+/g, ' ').replaceAll(/-{3,}/g, '---');

    expect(cells(markdown)).toEqual(cells(generated));
  });
});

describe('openApiDocument', () => {
  it('matches the committed openapi.json (rerun `npm run schema -w @sheavly/protocol`)', async () => {
    const committed: unknown = JSON.parse(await readFile(join(PACKAGE_ROOT, OPENAPI_FILE), 'utf8'));

    expect(committed).toEqual(openApiDocument());
  });

  it('has one operation per route, named after it, under its path and method', () => {
    const { paths } = openApiDocument();

    for (const [operationId, route] of Object.entries(API_ROUTES)) {
      expect(paths[route.path]?.[route.method]).toMatchObject({ operationId });
    }
  });

  it('names each route after what it does: get/query/list for a read, a verb for a change', () => {
    for (const [operationId, route] of Object.entries(API_ROUTES)) {
      const reads = /^(get|query|list|stream)[A-Z]/.test(operationId);

      expect({ operationId, reads }).toEqual({ operationId, reads: route.effect === 'read' });
    }
  });

  it('gives each path at most one route per method, and every path param a name', () => {
    const seen = new Set<string>();

    for (const route of Object.values(API_ROUTES)) {
      const key = `${route.method} ${route.path}`;

      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(route.path).toMatch(
        /^\/(conversations|stored-conversations|setup|adapters|profiles|default-profile|workspace-profiles|trusted-workspaces|permissions|terminal-settings|health|handshake)(\/(\{[a-z]+\}|[a-z-]+))*$/,
      );
    }
  });

  it('describes the stream as server-sent events of stream entries, and QUERY as its own method', () => {
    const { paths } = openApiDocument();
    const stream = {
      'text/event-stream': { itemSchema: { $ref: '#/components/schemas/StreamEntry' } },
    };

    expect(paths['/conversations/{id}/stream']?.query).toMatchObject({
      responses: { 200: { content: stream } },
    });
  });

  it('answers a sent prompt with JSON at once, never with a stream that waits for its run', () => {
    const { paths } = openApiDocument();

    expect(paths['/conversations/{id}/prompts']?.post).toMatchObject({
      responses: {
        200: {
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/SendPromptResponse' } },
          },
        },
      },
    });
  });

  it('has no route that delivers text to a running prompt', () => {
    expect(Object.keys(API_ROUTES)).not.toContain('sendFollowup');
    expect(Object.keys(openApiDocument().paths)).not.toContain('/conversations/{id}/followups');
  });

  it('yields a prompt with no body and a JSON acceptance response', () => {
    expect(API_ROUTES.yieldPrompt).toMatchObject({
      effect: 'change',
      method: 'post',
      path: '/conversations/{id}/yield',
      response: { status: 200 },
    });
    expect('body' in API_ROUTES.yieldPrompt).toBe(false);
    expect(openApiDocument().paths['/conversations/{id}/yield']?.post).toMatchObject({
      operationId: 'yieldPrompt',
    });
  });

  it('marks exactly health and the handshake public, and nothing else', () => {
    const marked = Object.entries(API_ROUTES)
      .filter(([, route]) => 'public' in route)
      .map(([name]) => name);

    expect(marked).toEqual(['getHealth', 'queryHandshake']);
  });

  it('lifts the bearer requirement from public operations only', () => {
    const { paths, security } = openApiDocument();

    expect(security).toEqual([{ bearer: [] }]);

    for (const [operationId, route] of Object.entries(API_ROUTES)) {
      const operation = paths[route.path]?.[route.method];

      expect({ operationId, security: (operation as { security?: unknown }).security }).toEqual({
        operationId,
        security: 'public' in route ? [] : undefined,
      });
    }
  });

  it('gives a public route no path parameter', () => {
    for (const route of Object.values(API_ROUTES)) {
      if ('public' in route) expect(route.path).not.toContain('{');
    }
  });

  it('only references schemas it defines', () => {
    const document = openApiDocument();
    const names = refsIn(document).map((ref) => ref.replace('#/components/schemas/', ''));

    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !(name in document.components.schemas))).toEqual([]);
  });
});
