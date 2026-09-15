// Warm-turn phase tracer — logs ms-from-start for every SSE event of one chat turn.
// Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/qa/chat-phase-trace.mjs "<question>" "<topic-or-empty>"
// Reads the API key from the env (API_KEY) so it can run against the live TLS server.
const API_KEY = process.env.API_KEY;
const question = process.argv[2] || 'Give me a one-line summary of my week.';
const topic = process.argv[3] || '';
const body = JSON.stringify({
  messages: [{ role: 'user', content: question }],
  ...(topic ? { topic } : {}),
});
const start = Date.now();
const res = await fetch('https://localhost:4338/api/chat/stream', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json' },
  body,
});
if (!res.ok) { console.log('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200)); process.exit(1); }
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let firstToken = null;
let lastPhase = null;
let lastPhaseT = 0;
loop: while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const parts = buf.split('\n');
  buf = parts.pop();
  for (const ln of parts) {
    if (!ln.startsWith('data: ')) continue;
    const t = Date.now() - start;
    let j; try { j = JSON.parse(ln.slice(6)); } catch { continue; }
    if (j.type === 'phase') {
      if (lastPhase) console.log('  (' + (t - lastPhaseT) + 'ms in ' + lastPhase + ')');
      console.log(t + 'ms  phase: ' + j.name);
      lastPhase = j.name; lastPhaseT = t;
    } else if (j.type === 'status') {
      console.log(t + 'ms  status hasRAG=' + j.hasRAG + ' tools=' + j.toolCount + ' belt=' + j.belt);
    } else {
      // any non-phase/status payload with text content = first model output
      const hasText = j.delta || j.text || j.content || (j.type && /delta|text|token|content/i.test(j.type));
      if (hasText && !firstToken) {
        firstToken = t;
        if (lastPhase) console.log('  (' + (t - lastPhaseT) + 'ms in ' + lastPhase + ')');
        console.log(t + 'ms  *** FIRST MODEL TOKEN (type=' + j.type + ') ***');
        break loop;
      }
    }
  }
}
console.log('TTFT: ' + firstToken + 'ms');
