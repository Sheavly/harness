import { describe, expect, it, vi } from 'vitest';
import { createServeCommand } from '../serve.helper.js';

describe('the serve command', () => {
  it('runs the server in this process with the arguments after serve and its environment', async () => {
    const runServer = vi.fn(() => Promise.resolve());
    const env = { SERVER_PORT: '0' };

    await createServeCommand({ runServer }).run({ args: ['--trust'], env });

    expect(runServer).toHaveBeenCalledWith({ args: ['--trust'], env });
  });

  it('leaves which arguments are wrong to the server: it passes them on, and its refusal through', async () => {
    const refusal = new Error('Unknown argument "--version": the server takes --trust');
    const runServer = vi.fn(() => Promise.reject(refusal));

    await expect(
      createServeCommand({ runServer }).run({ args: ['--version'], env: {} }),
    ).rejects.toBe(refusal);
    expect(runServer).toHaveBeenCalledWith({ args: ['--version'], env: {} });
  });

  it('is listed as serve, and its help says what it runs', () => {
    const { name, summary, help } = createServeCommand({ runServer: () => Promise.resolve() });

    expect({ name, summary }).toEqual({
      name: 'serve',
      summary: 'Run the server in the foreground',
    });
    expect(help).toContain('Usage: sheavly serve');
    expect(help).toContain('npm run serve -w @sheavly/backend');
  });
});
