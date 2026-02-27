/**
 * storage.js — Chrome.storage.local schema, defaults & helpers  (v3)
 * Shared by content.js, popup.js, sidebar.js (content-script context)
 */

/* ───────────────────────── Schema Defaults ───────────────────────── */

const STORAGE_DEFAULTS = {
  extensionEnabled: true,    // Global Master Switch - Added
  characterCards: [],
  activeCard: null,

  /**
   * Multi-lorebook system.
   * Each book: { id, name, enabled, entries[] }
   * Memory books use id = 'memory_YYYY-MM-DD_HHmm'
   */
  loreBooks: [],

  /* ── Global lorebook settings ── */
  loreScanDepth: 4,          // N last messages to scan for keywords
  loreTokenBudget: 2048,     // max tokens for all lorebook content combined
  loreRecursion: true,       // entries can trigger each other
  loreRecursionDepth: 3,     // max recursion passes
  loreVectorModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  loreVectorThreshold: 0.45, // cosine-sim threshold for vectorized matches
  loreDefaultTriggerMode: 'keyword', // 'keyword' | 'vectorized' — global scan strategy
  loreLanguage: 'English',  // Target language for AI-generated lore - Added

  /* ── Author's Note ── */
  authorNote: '',
  authorNoteDepth: 2,

  /* ── Chat / history ── */
  chatHistory: [],
  totalMessageCount: 0,      // lifetime msg counter for delay timed effects
  repliesSinceLastSummary: 0,

  /* ── API ── */
  apiKey: '',
  memorySummaryInterval: 10,

  /* ── Timed-effects runtime state  { entryId: { stickyUntil, cooldownUntil } } ── */
  loreTimedState: {},

  /* ── Misc ── */
  lastAssembledPrompt: '',
  notebookText: ''
};

/* ───────────── Lore Entry template ───────────── */

const LORE_ENTRY_DEFAULTS = {
  id: '',
  keyword: [],
  keysecondary: [],
  content: '',
  enabled: true,
  triggerMode: 'keyword',        // 'keyword' | 'constant' | 'vectorized'
  constant: false,
  selective: false,
  selectiveLogic: 0,             // 0=AND  1=NOT_ANY  2=NOT_ALL
  scanDepth: null,               // null → use global loreScanDepth
  position: 'after_char',        // before_char | after_char | at_depth | an_top | an_bottom
  depth: 4,
  order: 100,
  excludeRecursion: false,
  probability: 100,
  useProbability: false,
  sticky: 0,
  cooldown: 0,
  delay: 0,
  group: '',
  pending: false,
  embedding: null,               // LEGACY — single embedding (backward compat)
  embeddings: null               // Array of float arrays — multi-chunk embeddings
};

/* ───────────────────────── Helpers ───────────────────────── */

async function storageGetAll() {
  return new Promise(r => chrome.storage.local.get(STORAGE_DEFAULTS, r));
}

async function storageGet(keys) {
  const defs = {};
  (Array.isArray(keys) ? keys : [keys]).forEach(k => {
    if (k in STORAGE_DEFAULTS) defs[k] = STORAGE_DEFAULTS[k];
  });
  return new Promise(r => chrome.storage.local.get(defs, r));
}

async function storageSet(obj) {
  return new Promise(r => chrome.storage.local.set(obj, () => r()));
}

function estimateTokens(text) {
  return text ? Math.ceil(text.length / 4) : 0;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function createLoreEntry(overrides = {}) {
  return { ...LORE_ENTRY_DEFAULTS, id: uid(), ...overrides };
}
