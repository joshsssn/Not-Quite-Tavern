/**
 * background.js — Service Worker  (v3)
 *
 * • Memory generation → date-stamped memory books  🧠 memory_YYYY-MM-DD_HHmm
 * • WREC lorebook generation → ⚡ WREC Generated
 * • Offscreen document management for Transformers.js embeddings
 * • Message routing
 */

/* ══════════════ §1  STORAGE HELPERS (service worker scope) ══════════════ */

const SW_DEFAULTS = {
  extensionEnabled: true,
  characterCards: [], activeCard: null, loreBooks: [], chatHistory: [],
  apiKey: '', memorySummaryInterval: 10, repliesSinceLastSummary: 0,
  totalMessageCount: 0, loreTimedState: {}, authorNote: '', authorNoteDepth: 2,
  loreScanDepth: 4, loreTokenBudget: 2048, loreRecursion: true, loreRecursionDepth: 3,
  loreVectorModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  loreVectorThreshold: 0.45, loreDefaultTriggerMode: 'keyword',
  loreLanguage: 'English', 
  lastAssembledPrompt: '', notebookText: ''
};

function sGet(keys) {
  const defs = {};
  (Array.isArray(keys) ? keys : [keys]).forEach(k => { if (k in SW_DEFAULTS) defs[k] = SW_DEFAULTS[k]; });
  return new Promise(r => chrome.storage.local.get(defs, r));
}
function sSet(obj) { return new Promise(r => chrome.storage.local.set(obj, () => r())); }
function sGetAll() { return new Promise(r => chrome.storage.local.get(SW_DEFAULTS, r)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

/* ══════════════ §2  OPENROUTER API ══════════════ */

async function callFlash(prompt, apiKey) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'google/gemini-2.0-flash-001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

/* ══════════════ §3  MEMORY GENERATION ══════════════ */

async function summarizeMemory() {
  const data = await sGet(['chatHistory', 'apiKey', 'loreBooks', 'activeCard', 'characterCards', 'loreLanguage']);
  if (!data.apiKey) throw new Error('No API key');
  const hist = data.chatHistory || [];
  if (hist.length < 4) throw new Error('Not enough history');

  const card = (data.characterCards || []).find(c => c.id === data.activeCard);
  const charName = card?.name || 'Character';

  const block = hist.slice(-30).map(m => `${m.role === 'user' ? 'User' : charName}: ${m.text.substring(0, 600)}`).join('\n');

  const prompt = `You are a lorebook-entry generator for a roleplay between a User and "${charName}".
Analyse the conversation below and produce 1-5 lorebook entries that capture important NEW facts, relationships, events or world details.

CRITICAL: All generated content (keywords and descriptive text) MUST be written in the following language: ${data.loreLanguage || 'English'}.

Each entry MUST be a JSON object with:
  "keyword": [array of trigger keywords],
  "content": "descriptive text (2-4 sentences max)"

Return ONLY a JSON array, no commentary.

--- CONVERSATION ---
${block}`;

  const raw = await callFlash(prompt, data.apiKey);
  let entries;
  try {
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
    entries = JSON.parse(cleaned);
    if (!Array.isArray(entries)) entries = [entries];
  } catch { throw new Error('Parse error: ' + raw.substring(0, 200)); }

  // Create date-stamped memory book
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const bookName = `🧠 memory_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;

  const loreEntries = entries.map(e => ({
    id: uid(),
    keyword: Array.isArray(e.keyword) ? e.keyword : (e.keyword || '').split(',').map(s => s.trim()),
    keysecondary: [],
    content: e.content || '',
    enabled: true,
    triggerMode: 'keyword',
    constant: false,
    selective: false,
    selectiveLogic: 0,
    scanDepth: null,
    position: 'after_char',
    depth: 4,
    order: 100,
    excludeRecursion: false,
    probability: 100,
    useProbability: false,
    sticky: 0, cooldown: 0, delay: 0,
    group: '', pending: false, embedding: null
  }));

  const memBook = { id: bookName, name: bookName, enabled: true, entries: loreEntries };
  const books = [...(data.loreBooks || []), memBook];
  await sSet({ loreBooks: books, repliesSinceLastSummary: 0 });

  // Auto-vectorize memory entries if global mode is vectorized
  const globalMode = data.loreDefaultTriggerMode || (await sGet(['loreDefaultTriggerMode'])).loreDefaultTriggerMode;
  if (globalMode === 'vectorized') {
    let vecCount = 0;
    for (const entry of memBook.entries) {
      // Multi-chunk: keywords chunk + content in ~400 char chunks
      const kw = (entry.keyword || []).join(', ');
      const content = (entry.content || '').trim();
      const texts = [];
      if (kw) texts.push(kw);
      if (content) {
        const CHUNK = 400, OVERLAP = 100;
        for (let i = 0; i < content.length; i += CHUNK - OVERLAP) {
          texts.push(content.substring(i, i + CHUNK));
          if (texts.length >= 6) break;
        }
      }
      if (!texts.length) texts.push('empty');
      try {
        const embeddings = [];
        for (const text of texts) {
          const emb = await computeEmbedding(text);
          embeddings.push(emb);
        }
        entry.embeddings = embeddings;
        entry.embedding = null;
        entry.triggerMode = 'vectorized';
        vecCount++;
      } catch (e) { console.warn('[RP] Auto-vectorize memory entry failed:', e); }
    }
    if (vecCount > 0) {
      // Re-save books with updated embeddings
      const freshBooks = (await sGet(['loreBooks'])).loreBooks || [];
      const idx = freshBooks.findIndex(b => b.id === bookName);
      if (idx >= 0) { freshBooks[idx] = memBook; await sSet({ loreBooks: freshBooks }); }
      console.log(`[RP] Auto-vectorized ${vecCount} memory entries`);
    }
  }

  // Chrome notification
  try {
    chrome.notifications.create(`mem_${Date.now()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: '🧠 Memory Created',
      message: `"${bookName}" — ${loreEntries.length} new lorebook entr${loreEntries.length === 1 ? 'y' : 'ies'}`
    });
  } catch {}

  return { bookName, count: loreEntries.length };
}

/* ══════════════ §4  WREC: Generate Lorebook from Card ══════════════ */

async function generateWrec() {
  const data = await sGet(['characterCards', 'activeCard', 'apiKey', 'loreBooks', 'loreLanguage']);
  if (!data.apiKey) throw new Error('No API key');
  const card = (data.characterCards || []).find(c => c.id === data.activeCard);
  if (!card) throw new Error('No active card');

  const blob = [card.systemPrompt, card.description, card.personality, card.scenario, card.name].filter(Boolean).join('\n');
  const prompt = `You are a lorebook extraction engine. Given the character description below, produce 5-15 lorebook entries.

CRITICAL: All generated content (keywords and descriptive text) MUST be written in the following language: ${data.loreLanguage || 'English'}.

Each entry MUST be JSON: { "keyword": ["k1","k2"], "content": "descriptive text" }

Return ONLY a JSON array.

--- CHARACTER ---
${blob.substring(0, 3000)}`;

  const raw = await callFlash(prompt, data.apiKey);
  let entries;
  try {
    entries = JSON.parse(raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim());
    if (!Array.isArray(entries)) entries = [entries];
  } catch { throw new Error('Parse error'); }

  const wrecEntries = entries.map(e => ({
    id: uid(),
    keyword: Array.isArray(e.keyword) ? e.keyword : [],
    keysecondary: [],
    content: e.content || '',
    enabled: true,
    triggerMode: 'keyword',
    constant: false,
    selective: false,
    selectiveLogic: 0,
    scanDepth: null,
    position: 'after_char',
    depth: 4,
    order: 100,
    excludeRecursion: false,
    probability: 100,
    useProbability: false,
    sticky: 0, cooldown: 0, delay: 0,
    group: '', pending: false, embedding: null
  }));

  // Replace or create the WREC book
  let books = (data.loreBooks || []).filter(b => b.name !== '⚡ WREC Generated');
  books.push({ id: uid(), name: '⚡ WREC Generated', enabled: true, entries: wrecEntries });
  await sSet({ loreBooks: books });

  return { count: wrecEntries.length };
}

/* ══════════════ §5  OFFSCREEN DOCUMENT (Embeddings) ══════════════ */

let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) return;
  const existing = await chrome.offscreen.hasDocument?.() ?? false;
  if (existing) { offscreenReady = true; return; }
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run Transformers.js embedding model for vectorized lorebook matching'
    });
    offscreenReady = true;
  } catch (e) {
    if (e.message?.includes('already exists')) offscreenReady = true;
    else throw e;
  }
}

async function computeEmbedding(text) {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: '_OFFSCREEN_EMBED', target: 'offscreen', text }, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp?.error || 'Embed failed'));
      resolve(resp.embedding);
    });
  });
}

/* ══════════════ §6  SIDE PANEL SETUP ══════════════ */

chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

/* ══════════════ §7  MESSAGE ROUTER ══════════════ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Skip messages targeted at offscreen document
  if (msg.target === 'offscreen') return;

  switch (msg.type) {
    /* ── Memory ── */
    case 'SUMMARIZE_MEMORY':
      summarizeMemory()
        .then(r => sendResponse({ ok: true, ...r }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    /* ── WREC ── */
    case 'GENERATE_WREC':
      generateWrec()
        .then(r => sendResponse({ ok: true, ...r }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    /* ── Embedding ── */
    case 'COMPUTE_EMBEDDING':
      computeEmbedding(msg.text)
        .then(emb => sendResponse({ ok: true, embedding: emb }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    /* ── Reset conversation ── */
    case 'RESET_CONVERSATION':
      sSet({ chatHistory: [], repliesSinceLastSummary: 0, totalMessageCount: 0, loreTimedState: {} })
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    /* ── Ping ── */
    case 'PING':
      sendResponse({ ok: true, source: 'background' });
      break;

    /* ── Import SillyTavern lorebook ── */
    case 'IMPORT_ST_LOREBOOK': {
      const json = msg.data;
      try {
        let raw = json.entries ?? json.data?.entries ?? null;
        if (!raw) throw new Error('Cannot find entries');
        const stEntries = Array.isArray(raw) ? raw : Object.values(raw);
        if (!stEntries.length) throw new Error('No entries found');
        const posMap = { 0: 'before_char', 1: 'after_char', 4: 'at_depth', 5: 'an_top', 6: 'an_bottom' };
        const mapped = stEntries.map(e => ({
          id: uid(),
          keyword: Array.isArray(e.key) ? e.key : (e.key || '').split(',').map(s => s.trim()),
          keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
          content: e.content || '',
          enabled: !e.disable,
          triggerMode: e.vectorized ? 'vectorized' : (e.constant ? 'constant' : 'keyword'),
          constant: !!e.constant,
          selective: !!e.selective,
          selectiveLogic: e.selectiveLogic || 0,
          scanDepth: e.scanDepth ?? null,
          position: posMap[e.position] || 'after_char',
          depth: e.depth ?? 4,
          order: e.order ?? 100,
          excludeRecursion: !!e.excludeRecursion,
          probability: e.probability ?? 100,
          useProbability: !!e.useProbability,
          sticky: e.extensions?.sticky ?? 0,
          cooldown: e.extensions?.cooldown ?? 0,
          delay: e.extensions?.delay ?? 0,
          group: e.group || '',
          pending: false,
          embedding: null
        }));
        const bookName = json.name || json.data?.name || 'ST Import';
        sGet(['loreBooks']).then(d => {
          const books = [...(d.loreBooks || []), { id: uid(), name: bookName, enabled: true, entries: mapped }];
          sSet({ loreBooks: books }).then(() => sendResponse({ ok: true, count: mapped.length, bookName }));
        });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
      return true;
    }

    /* ── OpenRouter call (generic) ── */
    case 'CALL_API': {
      (async () => {
        try {
          const data = await sGet(['apiKey']);
          const result = await callFlash(msg.prompt, data.apiKey);
          sendResponse({ ok: true, result });
        } catch (e) { sendResponse({ ok: false, error: e.message }); }
      })();
      return true;
    }
  }
});

console.log('[RP] Background service worker ready (v3)');
