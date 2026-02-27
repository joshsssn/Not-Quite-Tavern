/**
 * offscreen.js — Transformers.js embeddings via offscreen document
 *
 * Loads Xenova/paraphrase-multilingual-MiniLM-L12-v2 (multilingual, French OK)
 * Model is cached in IndexedDB by Transformers.js after first download (~120 MB).
 *
 * MV3 CSP blocks blob: workers used by ONNX Runtime's multi-threaded WASM.
 * We patch the Worker constructor BEFORE importing transformers.min.js so that
 * any blob-worker probes during module initialization get silently stubbed out.
 */

// ── 1. Intercept blob: Worker creation (before any ONNX code evaluates) ──
const _NativeWorker = globalThis.Worker;
globalThis.Worker = function PatchedWorker(scriptURL, opts) {
  if (typeof scriptURL === 'string' && scriptURL.startsWith('blob:')) {
    console.warn('[RP-Offscreen] Suppressed blob: worker (MV3 CSP)');
    // Return a stub that looks enough like a Worker to avoid crashes
    return Object.assign(new EventTarget(), {
      postMessage() {},
      terminate() {},
      onmessage: null,
      onerror: null,
      onmessageerror: null,
    });
  }
  return new _NativeWorker(scriptURL, opts);
};

// ── 2. Dynamic import so the Worker patch is in place first ──
const { pipeline, env } = await import('./transformers.min.js');

// ── 3. Configure ONNX for single-threaded, non-proxied operation ──
env.backends.onnx.wasm.wasmPaths =
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/';
env.backends.onnx.wasm.proxy = false;
env.backends.onnx.wasm.numThreads = 1;
// Disable local model check — models fetched from HF Hub via fetch()
env.allowLocalModels = false;

let embedder = null;
let loading = false;

async function getEmbedder() {
  if (embedder) return embedder;
  if (loading) {
    while (loading) await new Promise(r => setTimeout(r, 200));
    return embedder;
  }
  loading = true;
  try {
    embedder = await pipeline(
      'feature-extraction',
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
      { quantized: true }
    );
    console.log('[RP-Offscreen] Model loaded');
    loading = false;
    return embedder;
  } catch (e) {
    loading = false;
    throw e;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === '_OFFSCREEN_EMBED') {
    (async () => {
      try {
        const pipe = await getEmbedder();
        const output = await pipe(msg.text, { pooling: 'mean', normalize: true });
        sendResponse({ ok: true, embedding: Array.from(output.data) });
      } catch (e) {
        console.error('[RP-Offscreen] Embed error:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});

console.log('[RP-Offscreen] Ready');
