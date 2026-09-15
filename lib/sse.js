/**
 * Server-Sent Events helpers.
 *
 * Every SSE endpoint in the app sends JSON-encoded events in the standard
 * `data: {…}\n\n` frame. `makeSender` returns a bound function that does
 * exactly that against a given ReadableStream controller.
 */

/**
 * Build a `send(obj)` function that writes `data: <json>\n\n` to a
 * ReadableStream controller, using a fresh TextEncoder per stream.
 *
 * @param {ReadableStreamDefaultController} controller
 * @returns {(obj: unknown) => void}
 */
export function makeSender(controller) {
  const encoder = new TextEncoder();
  let _closed = false;
  return (obj) => {
    if (_closed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    } catch {
      _closed = true;
    }
  };
}
