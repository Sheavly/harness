/**
 * Test-only: `fetch`, with the streams it answers wrapped so a test can cut them, as a network that
 * fails does: the reader gets an error where the stream was, and what the server went on to send is
 * never read. `cut` cuts every stream that is open; a stream opened after it is whole. `opened` is
 * how many streams were opened, which says that a client opened again. It wraps the global `fetch`,
 * or `inner`: a test that serves an app in-process passes a fetch that calls it.
 */
export function cuttingFetch(inner: typeof globalThis.fetch = fetch) {
  const cuts: (() => void)[] = [];
  let opened = 0;
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await inner(input, init);

    if (!response.body) return response;

    opened += 1;

    const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
    let cutOff = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        cuts.push(() => {
          cutOff = true;
          controller.error(new TypeError('terminated'));
          void reader.cancel();
        });
      },
      async pull(controller) {
        const next = await reader.read();

        // A cut stream is already an error: what the cancelled reader answers is not for it.
        if (cutOff) return;

        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel(reason: unknown) {
        await reader.cancel(reason);
      },
    });

    return new Response(body, { status: response.status, headers: response.headers });
  };

  return {
    fetch: wrapped,
    cut: () => {
      for (const cutOne of cuts.splice(0)) cutOne();
    },
    opened: () => opened,
  };
}
