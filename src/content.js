/**
 * content.js — Core Gemini injection + Full SillyTavern Lorebook Engine  (v3)
 *
 * Features:
 *   - Keyword / Constant / Vectorized trigger modes
 *   - Scan Depth (global + per-entry override)
 *   - Selective keywords (AND / NOT_ANY / NOT_ALL)
 *   - Recursion (entries triggering other entries)
 *   - Timed Effects (Sticky / Cooldown / Delay)
 *   - Probability
 *   - Insertion Position (before_char / after_char / at_depth / an_top / an_bottom)
 *   - Insertion Order + Token Budget
 */

(function () {
  'use strict';

  const TAG = '[RP]';
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  /** Returns false once the extension has been reloaded/invalidated. */
  const contextAlive = () => !!chrome.runtime?.id;

  /* ══════════════ §1  DOM SELECTORS ══════════════ */

  const SEL = {
    editor: [
      // Gemini 2024-2026 variants
      'rich-textarea .ql-editor[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'rich-textarea [contenteditable="true"]',
      'rich-textarea p[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      // Modern Gemini (Angular Material / custom elements)
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="plaintext-only"][role="textbox"]',
      'div[contenteditable="plaintext-only"]',
      '[data-placeholder][contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      '[role="textbox"][contenteditable]',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="message" i]',
      'textarea[placeholder]',
      // Generic input area
      '.input-area div[contenteditable="true"]',
      '.chat-input div[contenteditable="true"]',
      '.input-wrapper div[contenteditable="true"]',
      // Last resort — any contenteditable in the bottom area
      'div[contenteditable="true"]'
    ],
    sendButton: [
      'button.send-button',
      'button[data-test-id="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Envoyer"]',
      'button[aria-label="Envoyer le message"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[aria-label*="Envoyer" i]',
      'button[mattooltip="Send"]',
      'button[mattooltip="Envoyer"]',
      'button[mat-tooltip*="Send" i]',
      'button[aria-label*="Submit" i]',
      'button[data-testid*="send" i]',
    ],
    modelTurn: [
      'model-response',
      'message-content.model-response',
      '.model-response-text',
      'div[data-source-type="model"]',
      '.response-container .markdown',
      'div[data-testid="model-response"]',
      '.conversation-container model-response',
      '[class*="model-response"]',
      '[class*="response-content"]',
      'div[data-turn-role="model"]',
      '.chat-turn-container [data-role="model"]',
      'message-content[class*="model"]',
      '.turn-content.model-turn',
      '[data-message-author-role="model"]'
    ],
    userTurn: [
      'user-query',
      'message-content.user-query',
      'div[data-source-type="user"]',
      'div[data-testid="user-query"]',
      '[class*="user-query"]',
      'div[data-turn-role="user"]',
      '[data-message-author-role="user"]'
    ]
  };

  function q(sels, root = document) {
    for (const s of sels) {
      try { const el = root.querySelector(s); if (el) return el; } catch {}
    }
    return null;
  }
  function qAll(sels, root = document) {
    const set = new Set(); const out = [];
    for (const s of sels) {
      try { root.querySelectorAll(s).forEach(el => { if (!set.has(el)) { set.add(el); out.push(el); } }); } catch {}
    }
    return out;
  }
  function findSendButton() {
    const fromSel = q(SEL.sendButton);
    if (fromSel) { log('Send button found via selector'); return fromSel; }
    // Proximity search — find button near the editor
    const editor = q(SEL.editor);
    if (!editor) { warn('findSendButton: no editor found'); return null; }
    const container = editor.closest('form') || editor.closest('[class*="input-area"]') ||
      editor.closest('[class*="chat-input"]') || editor.closest('[class*="bottom"]') ||
      editor.closest('[class*="footer"]') || editor.closest('[class*="prompt"]') ||
      editor.parentElement?.parentElement?.parentElement?.parentElement;
    if (!container) { warn('findSendButton: no container'); return null; }
    // Pass 1: label match
    for (const btn of container.querySelectorAll('button')) {
      const lbl = (btn.getAttribute('aria-label') || btn.getAttribute('mattooltip') || btn.textContent || '').toLowerCase();
      if (lbl.includes('send') || lbl.includes('envoyer') || lbl.includes('submit')) { log('Send button found via label:', lbl); return btn; }
    }
    // Pass 2: icon button
    for (const btn of container.querySelectorAll('button')) {
      if (btn.querySelector('svg, mat-icon, .material-icons, .icon, [class*="icon"]')) return btn;
    }
    warn('findSendButton: no button found in container');
    return null;
  }

  /* ══════════════ §2  CACHED STORAGE ══════════════ */

  let cache = null;

  async function refreshCache() {
    if (!contextAlive()) return;
    try {
      cache = await storageGetAll();
      // Migration: flat loreEntries → loreBooks
      if (cache.loreEntries && cache.loreEntries.length > 0 && (!cache.loreBooks || cache.loreBooks.length === 0)) {
        const migrated = { id: uid(), name: 'Legacy Lorebook', enabled: true, entries: cache.loreEntries };
        cache.loreBooks = [migrated];
        storageSet({ loreBooks: [migrated], loreEntries: [] }).catch(() => {});
      }
      log('Cache ready | enabled:', cache.extensionEnabled !== false,
          '| activeCard:', cache.activeCard,
          '| cards:', (cache.characterCards||[]).length,
          '| books:', (cache.loreBooks||[]).length,
          '| authorNote:', !!(cache.authorNote));
    } catch (e) { warn('Cache refresh failed:', e); }
  }
  refreshCache();
  chrome.storage.onChanged.addListener(() => { if (contextAlive()) refreshCache(); });

  /* ══════════════ §3  LOREBOOK ENGINE ══════════════ */

  /** Build scan buffer from last N messages */
  function getScanBuffer(depth) {
    if (!cache) return '';
    return (cache.chatHistory || []).slice(-depth).map(m => m.text).join(' ');
  }

  function kwMatch(kw, text) {
    return kw && text && text.toLowerCase().includes(kw.toLowerCase());
  }

  /** Check primary keywords */
  function checkPrimary(entry, scanText) {
    if (!entry.keyword || entry.keyword.length === 0) return false;
    return entry.keyword.some(kw => kwMatch(kw, scanText));
  }

  /** Check secondary/selective keywords */
  function checkSecondary(entry, scanText) {
    if (!entry.selective || !entry.keysecondary || entry.keysecondary.length === 0) return true;
    const valid = entry.keysecondary.filter(k => k);
    const hits = valid.filter(kw => kwMatch(kw, scanText));
    switch (entry.selectiveLogic) {
      case 0: return hits.length === valid.length;       // AND
      case 1: return hits.length === 0;                  // NOT_ANY
      case 2: return hits.length < valid.length;         // NOT_ALL
      default: return true;
    }
  }

  /** Check timed effects */
  function checkTimed(entry, timedState, totalMsg) {
    const st = timedState[entry.id] || {};
    if (entry.delay > 0 && totalMsg < entry.delay) return { ok: false, sticky: false };
    if (st.cooldownUntil && totalMsg < st.cooldownUntil) return { ok: false, sticky: false };
    if (st.stickyUntil && totalMsg <= st.stickyUntil) return { ok: true, sticky: true };
    return { ok: true, sticky: false };
  }

  function checkProb(entry) {
    if (!entry.useProbability || entry.probability >= 100) return true;
    if (entry.probability <= 0) return false;
    return Math.random() * 100 < entry.probability;
  }

  function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
  }

  /**
   * Full lorebook scan — returns matched entries sorted by order.
   * @param {string} userMessage
   * @param {number[]|null} userEmbedding - for vectorized mode
   */
  function scanLorebook(userMessage, userEmbedding = null) {
    if (!cache) return [];

    const gDepth = cache.loreScanDepth || 4;
    const timedState = cache.loreTimedState || {};
    const totalMsg = cache.totalMessageCount || 0;
    const budget = cache.loreTokenBudget || 2048;
    const doRecursion = cache.loreRecursion !== false;
    const maxRecDepth = cache.loreRecursionDepth || 3;
    const vecThreshold = cache.loreVectorThreshold || 0.45;

    // Gather all enabled entries from enabled books
    const all = (cache.loreBooks || [])
      .filter(b => b.enabled)
      .flatMap(b => (b.entries || []).map(e => ({ ...e, _bk: b.id })));

    const entryMap = new Map();
    all.forEach(e => entryMap.set(e.id, e));

    const triggered = new Set();

    // ── Pass 1: direct triggers ──
    for (const e of all) {
      if (!e.enabled || e.pending) continue;
      const t = checkTimed(e, timedState, totalMsg);
      if (!t.ok) continue;

      // Constant
      if (e.constant || e.triggerMode === 'constant') {
        if (checkProb(e)) triggered.add(e.id);
        continue;
      }
      // Sticky override
      if (t.sticky) { triggered.add(e.id); continue; }

      // Vectorized — either per-entry mode OR global mode with embeddings stored
      const globalVec = (cache.loreDefaultTriggerMode === 'vectorized');
      const entryEmbs = e.embeddings || (e.embedding ? [e.embedding] : null);
      if ((e.triggerMode === 'vectorized' || (globalVec && entryEmbs)) && entryEmbs) {
        if (userEmbedding) {
          let maxSim = 0;
          for (const emb of entryEmbs) {
            const s = cosineSim(userEmbedding, emb);
            if (s > maxSim) maxSim = s;
          }
          if (maxSim >= vecThreshold && checkProb(e))
            triggered.add(e.id);
        }
        // Only skip keyword fallback if the entry is explicitly set to vectorized mode
        if (e.triggerMode === 'vectorized') continue;
        // For keyword entries in global-vec mode: continue to also try keyword match below
        if (triggered.has(e.id)) continue; // already matched via vector, skip keyword
      }

      // Keyword (default) — also runs for globalVec entries without embeddings
      const depth = e.scanDepth || gDepth;
      const buf = getScanBuffer(depth) + ' ' + userMessage;
      if (!checkPrimary(e, buf)) continue;
      if (!checkSecondary(e, buf)) continue;
      if (!checkProb(e)) continue;
      triggered.add(e.id);
    }

    // ── Pass 2+: recursion ──
    if (doRecursion) {
      for (let d = 0; d < maxRecDepth; d++) {
        const corpus = [...triggered].map(id => entryMap.get(id)).filter(e => e && !e.excludeRecursion).map(e => e.content).join(' ');
        if (!corpus) break;
        let added = false;
        for (const e of all) {
          if (!e.enabled || e.pending || triggered.has(e.id)) continue;
          if (e.constant || e.triggerMode === 'constant' || e.triggerMode === 'vectorized') continue;
          const t = checkTimed(e, timedState, totalMsg);
          if (!t.ok) continue;
          if (checkPrimary(e, corpus) && checkSecondary(e, corpus) && checkProb(e)) {
            triggered.add(e.id); added = true;
          }
        }
        if (!added) break;
      }
    }

    // ── Sort by order ──
    let result = [...triggered].map(id => entryMap.get(id)).filter(Boolean)
      .sort((a, b) => (a.order || 100) - (b.order || 100));

    // ── Apply token budget (constants first) ──
    const constants = result.filter(e => e.constant || e.triggerMode === 'constant');
    const others = result.filter(e => !e.constant && e.triggerMode !== 'constant');
    let used = 0;
    const final = [];
    for (const e of [...constants, ...others]) {
      const t = estimateTokens(e.content);
      if (used + t <= budget) { final.push(e); used += t; }
    }

    // ── Update timed state (non-blocking) ──
    const newTS = { ...timedState };

    for (const e of final) {
      if (e.sticky > 0) {
        // (re-)start or extend sticky window
        newTS[e.id] = { ...newTS[e.id], stickyUntil: totalMsg + e.sticky };
        delete newTS[e.id]?.cooldownUntil; // fresh trigger clears any lingering cooldown
      } else if (e.cooldown > 0) {
        // BUG FIX: entries with cooldown but no sticky need cooldown set immediately on trigger
        newTS[e.id] = { ...newTS[e.id], cooldownUntil: totalMsg + 1 + e.cooldown };
        // +1 because totalMsg hasn’t been incremented yet for the current message
      }
    }

    // Transition: sticky expired this message → start cooldown
    for (const [id, st] of Object.entries(newTS)) {
      if (!st.stickyUntil) continue;
      if (totalMsg > st.stickyUntil && !triggered.has(id)) {
        const ent = entryMap.get(id);
        if (ent && ent.cooldown > 0) {
          newTS[id] = { cooldownUntil: totalMsg + ent.cooldown };
        } else {
          delete newTS[id]; // nothing left to track
        }
      }
    }

    // Prune fully-expired entries (keeps the state object lean)
    for (const [id, st] of Object.entries(newTS)) {
      const expired = (!st.stickyUntil || totalMsg > st.stickyUntil)
                   && (!st.cooldownUntil || totalMsg >= st.cooldownUntil);
      if (expired) delete newTS[id];
    }

    storageSet({ loreTimedState: newTS }).catch(() => {});
    if (cache) cache.loreTimedState = newTS;

    log(`Lorebook: ${final.length} entries, ${used} tok`);
    return final;
  }

  /* ══════════════ §4  PROMPT ASSEMBLY ══════════════ */

  function assemblePrompt(userMessage, matched) {
    if (!cache || !cache.activeCard) return null;
    const card = cache.characterCards.find(c => c.id === cache.activeCard);
    if (!card) return null;

    // Group by position
    const byPos = { before_char: [], after_char: [], at_depth: [], an_top: [], an_bottom: [] };
    for (const e of matched) byPos[e.position || 'after_char']?.push(e) ?? byPos.after_char.push(e);

    const parts = [];

    // Before-char lore
    if (byPos.before_char.length) {
      parts.push(`<lorebook position="before_char">\n${byPos.before_char.map(e => `[${(e.keyword||[]).join(', ')}]: ${e.content}`).join('\n')}\n</lorebook>`);
    }

    // Character card
    const cl = [card.systemPrompt, card.name ? `Name: ${card.name}` : '', card.description ? `Description: ${card.description}` : '',
      card.personality ? `Personality: ${card.personality}` : '', card.scenario ? `Scenario: ${card.scenario}` : ''].filter(Boolean);
    parts.push(`<character>\n${cl.join('\n')}\n</character>`);

    // After-char lore
    if (byPos.after_char.length) {
      parts.push(`<lorebook>\n${byPos.after_char.map(e => `[${(e.keyword||[]).join(', ')}]: ${e.content}`).join('\n')}\n</lorebook>`);
    }

    // Author's Note (with an_top / an_bottom lore)
    const anParts = [];
    if (byPos.an_top.length) anParts.push(byPos.an_top.map(e => e.content).join('\n'));
    if (cache.authorNote) anParts.push(cache.authorNote);
    if (byPos.an_bottom.length) anParts.push(byPos.an_bottom.map(e => e.content).join('\n'));
    if (anParts.length) parts.push(`<author_note>\n${anParts.join('\n')}\n</author_note>`);

    // At-depth lore
    if (byPos.at_depth.length) {
      parts.push(`<lorebook position="at_depth">\n${byPos.at_depth.map(e => `[${(e.keyword||[]).join(', ')} @d${e.depth||0}]: ${e.content}`).join('\n')}\n</lorebook>`);
    }

    if (parts.length === 0) return null;
    const assembled = `<context>\n${parts.join('\n\n')}\n</context>\n\n${userMessage}`;
    log('Assembled:', estimateTokens(assembled), 'tok');
    return assembled;
  }

  /* ══════════════ §5  EDITOR REPLACEMENT ══════════════ */

  /**
   * Replace editor content with assembled prompt text.
   * Uses multiple strategies because Gemini's framework may ignore some.
   */
  function replaceEditorText(editor, text) {
    const isTextarea = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';

    if (isTextarea) {
      // Textarea/input path: set .value + fire events
      const nativeSetter = Object.getOwnPropertyDescriptor(
        editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(editor, text);
      else editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      log('replaceEditorText: textarea path');
      return;
    }

    // ContentEditable path — try strategies in order of reliability
    editor.focus();

    // === Strategy 1: execCommand('insertText') — still works in many Chrome builds ===
    try {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.addRange(range);
      const ok = document.execCommand('insertText', false, text);
      if (ok && (editor.innerText || '').includes(text.substring(0, 30))) {
        log('replaceEditorText: execCommand succeeded');
        return;
      }
    } catch (e) { warn('execCommand failed:', e.message); }

    // === Strategy 2: Clipboard-based paste simulation ===
    try {
      // Select all first
      const sel = window.getSelection();
      sel.selectAllChildren(editor);

      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
        composed: true
      });
      editor.dispatchEvent(pasteEvt);

      // Verify it took
      const current = (editor.innerText || editor.textContent || '').trim();
      if (current.includes(text.substring(0, 30))) {
        log('replaceEditorText: paste simulation succeeded');
        return;
      }
    } catch (e) { warn('Paste simulation failed:', e.message); }

    // === Strategy 3: InputEvent with insertReplacementText ===
    try {
      // Clear content first
      editor.textContent = '';
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true, cancelable: true, composed: true
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true, composed: true
      }));

      // Set text via DOM
      const p = document.createElement('p');
      p.textContent = text;
      editor.appendChild(p);

      // Fire input events to notify framework
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true, cancelable: true, composed: true
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText',
        data: text,
        bubbles: true, composed: true
      }));
      log('replaceEditorText: InputEvent fallback');
    } catch (e) { warn('InputEvent fallback failed:', e.message); }
  }

  /* ══════════════ §6  PRE-SUBMIT HOOK ══════════════ */

  let hookBusy = false;
  let skipHook = false;

  /** Check if any enabled vectorized entries with stored embeddings exist,
   *  OR if the global trigger mode is set to 'vectorized'. */
  function hasVectorizedEntries() {
    if (!cache) return false;
    if (cache.loreDefaultTriggerMode === 'vectorized') return true;
    return (cache.loreBooks || []).some(b => b.enabled &&
      (b.entries || []).some(e => e.enabled && e.triggerMode === 'vectorized' && (e.embeddings || e.embedding)));
  }

  /** Compute embedding via offscreen document */
  function computeUserEmbedding(text) {
    return new Promise((resolve, reject) => {
      if (!contextAlive()) return reject(new Error('Extension context invalidated'));
      chrome.runtime.sendMessage({ type: 'COMPUTE_EMBEDDING', text }, r => {
        if (!contextAlive() || chrome.runtime.lastError)
          return reject(new Error((chrome.runtime.lastError?.message) || 'Context lost'));
        if (!r?.ok) return reject(new Error(r?.error || 'Embedding failed'));
        resolve(r.embedding);
      });
    });
  }

  /** Core inject: scan + assemble + replace + save history */
  function doInject(editor, raw, embedding) {
    // Master toggle check — THE authoritative gate
    if (cache && cache.extensionEnabled === false) {
      log('doInject BLOCKED — extension is disabled');
      return null;
    }
    log('doInject called — raw:', raw.substring(0, 60), '| card:', cache?.activeCard, '| embedding:', !!embedding);
    const matched = scanLorebook(raw, embedding);
    const assembled = assemblePrompt(raw, matched);
    if (assembled) {
      log('Prompt assembled, replacing editor text —', estimateTokens(assembled), 'tok, matched entries:', matched.length);
      replaceEditorText(editor, assembled);
    } else {
      log('assemblePrompt returned null — check active card & card data');
    }

    const entry = { role: 'user', text: raw, timestamp: Date.now() };
    const hist = [...(cache.chatHistory || []), entry];
    const newTotal = (cache.totalMessageCount || 0) + 1;
    cache.chatHistory = hist;
    cache.totalMessageCount = newTotal;
    storageSet({ chatHistory: hist, lastAssembledPrompt: assembled || raw, totalMessageCount: newTotal }).catch(() => {});
    return assembled;
  }

  /** Sync hook (keyword-only, no vectorized entries) — runs before event propagates */
  function preSubmitHookSync() {
    if (hookBusy || skipHook) return;
    const editor = q(SEL.editor);
    if (!editor) { warn('preSubmitHookSync: editor NOT FOUND'); return; }
    const raw = (editor.innerText || editor.textContent || editor.value || '').trim();
    if (!raw) { warn('preSubmitHookSync: editor is empty'); return; }
    if (!cache || !cache.activeCard) { log('No active card — pass-through'); return; }

    hookBusy = true;
    log('preSubmitHookSync — raw:', raw.substring(0, 60));
    const assembled = doInject(editor, raw, null);
    if (assembled) log('✓ Injected (sync):', raw.substring(0, 60));
    else warn('✗ Injection produced no output');
    setTimeout(() => { hookBusy = false; }, 600);
  }

  /** Async submit: compute embedding, inject, then re-click send */
  async function asyncSubmit(editor, raw, triggerSend) {
    hookBusy = true;
    log('asyncSubmit — raw:', raw.substring(0, 60));
    try {
      let embedding = null;
      try {
        embedding = await computeUserEmbedding(raw);
        log('✓ User embedding computed');
      } catch (err) {
        warn('Embedding failed, keyword-only fallback:', err);
      }
      doInject(editor, raw, embedding);
      log('✓ Injected (async):', raw.substring(0, 60));
    } catch (err) {
      warn('Async inject error:', err);
    }
    // Re-trigger send bypassing our hook
    skipHook = true;
    triggerSend();
    setTimeout(() => { skipHook = false; hookBusy = false; }, 600);
  }

  /* ══════════════ §7  INTERCEPTORS ══════════════ */

  function attachInterceptors() {
    const hookBtn = btn => {
      if (!btn || btn.__rpHooked) return;
      btn.__rpHooked = true;

      const handler = e => {
        if (cache && cache.extensionEnabled === false) return; // Extension disabled
        if (skipHook || hookBusy) return;
        const editor = q(SEL.editor);
        if (!editor) { warn('Hook fired but editor NOT FOUND'); return; }
        const raw = (editor.innerText || editor.textContent || editor.value || '').trim();
        if (!raw) { log('Hook fired but editor is empty'); return; }
        if (!cache || !cache.activeCard) { log('Hook fired but no active card — pass-through'); return; }

        log('Hook fired! raw:', raw.substring(0, 40), '| vectorized:', hasVectorizedEntries());

        if (hasVectorizedEntries()) {
          // ASYNC path: block send, compute embedding, then re-click
          e.preventDefault();
          e.stopImmediatePropagation();
          asyncSubmit(editor, raw, () => btn.click());
        } else {
          // SYNC path: keyword-only, text replaced before Gemini reads it
          preSubmitHookSync();
        }
      };

      btn.addEventListener('pointerdown', handler, true);
      btn.addEventListener('mousedown', handler, true);
      btn.addEventListener('click', handler, true);
      log('✓ Send button hooked:', btn.tagName, btn.className?.substring(0, 30), btn.getAttribute('aria-label'));
    };

    new MutationObserver(() => hookBtn(findSendButton())).observe(document.body, { childList: true, subtree: true });
    hookBtn(findSendButton());

    /* ── Diagnostic: periodically check if editor & send button can be found ── */
    let diagOnce = setTimeout(() => {
      const ed = q(SEL.editor);
      const btn = findSendButton();
      log('Diag: editor =', ed?.tagName, ed?.className?.substring(0, 40), '| sendBtn =', btn?.tagName, btn?.className?.substring(0, 30));
      if (!ed) warn('DIAGNOSTIC: Editor element NOT FOUND — selectors may be stale. Open DevTools → Elements and inspect the input area.');
      if (!btn) warn('DIAGNOSTIC: Send button NOT FOUND — selectors may be stale.');
    }, 3000);

    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (cache && cache.extensionEnabled === false) return; // Extension disabled
      if (skipHook || hookBusy) return;
      const editor = q(SEL.editor);
      if (!editor) return;
      const a = document.activeElement;
      if (a !== editor && !editor.contains(a)) return;

      const raw = (editor.innerText || editor.textContent || editor.value || '').trim();
      if (!raw || !cache || !cache.activeCard) return;

      log('Enter key hook! raw:', raw.substring(0, 40));

      if (hasVectorizedEntries()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        asyncSubmit(editor, raw, () => {
          const btn = findSendButton();
          if (btn) btn.click();
        });
      } else {
        preSubmitHookSync();
      }
    }, true);
    log('Interceptors attached');
  }

  /* ══════════════ §8  RESPONSE OBSERVER ══════════════ */

  function attachResponseObserver() {
    let lastCaptured = '', pending = '', stableN = 0, turnCount = 0;

    /** Try to find model response elements — broadened for Gemini DOM changes */
    function findModelTurns() {
      // Primary: use selector list
      const sel = qAll(SEL.modelTurn);
      if (sel.length) return sel;

      // Fallback: scan for common response container patterns
      const fallback = [];
      document.querySelectorAll('[class*="response"], [class*="model"], [data-role="model"]').forEach(el => {
        const t = (el.innerText || '').trim();
        if (t.length > 10 && !fallback.some(f => f.contains(el) || el.contains(f))) fallback.push(el);
      });
      return fallback;
    }

    let wasDisabled = false;

    const check = async () => {
      if (!contextAlive()) { teardown?.(); return; }

      // Extension disabled — reset tracking so we pick up fresh when re-enabled
      if (cache && cache.extensionEnabled === false) {
        if (!wasDisabled) {
          wasDisabled = true;
          lastCaptured = ''; pending = ''; stableN = 0; turnCount = 0;
          log('Response observer paused (extension disabled) — state reset');
        }
        return;
      }
      if (wasDisabled) { wasDisabled = false; log('Response observer resumed'); }

      const turns = findModelTurns();
      if (!turns.length) return;
      const last = turns[turns.length - 1];
      const text = (last.innerText || last.textContent || '').trim();
      if (!text || text.length < 2) return;

      // Detect streaming (various loading indicators)
      const streamSels = '.loading-indicator, .thinking-indicator, mat-progress-bar, .loading, [class*="streaming"], [class*="generating"]';
      const streaming = !!(document.querySelector(streamSels)
        || last.querySelector('[class*="cursor"], [class*="blink"], [class*="caret"]'));
      if (streaming) { stableN = 0; pending = text; return; }

      if (text !== pending) { pending = text; stableN = 0; return; }
      stableN++;
      if (stableN < 2 || text === lastCaptured) return;

      // New turn count check — avoid re-capturing same turn
      if (turns.length === turnCount && text === lastCaptured) return;
      turnCount = turns.length;
      lastCaptured = text; stableN = 0;

      try {
        if (!contextAlive()) { teardown?.(); return; }
        const d = await storageGet(['chatHistory', 'repliesSinceLastSummary', 'memorySummaryInterval', 'totalMessageCount']);
        const hist = d.chatHistory || [];
        // Avoid duplicate capture
        const lastH = hist[hist.length - 1];
        if (lastH && lastH.role === 'model' && lastH.text === text) return;

        hist.push({ role: 'model', text, timestamp: Date.now() });
        const cnt = (d.repliesSinceLastSummary || 0) + 1;
        const newT = (d.totalMessageCount || 0) + 1;
        await storageSet({ chatHistory: hist, repliesSinceLastSummary: cnt, totalMessageCount: newT });
        if (cache) { cache.chatHistory = hist; cache.repliesSinceLastSummary = cnt; cache.totalMessageCount = newT; }
        log(`Model reply captured (#${cnt}/${d.memorySummaryInterval || 10})`);
        if (cnt >= (d.memorySummaryInterval || 10)) {
          log('Auto-memory triggered');
          if (contextAlive()) chrome.runtime.sendMessage({ type: 'SUMMARIZE_MEMORY' }).catch(() => {});
          await storageSet({ repliesSinceLastSummary: 0 });
          if (cache) cache.repliesSinceLastSummary = 0;
        }
      } catch (e) {
        if (!contextAlive()) { teardown?.(); return; } // silently stop on invalidation
        warn('Response save error:', e);
      }
    };

    let mo, ivl;
    const teardown = () => { try { mo?.disconnect(); } catch {} clearInterval(ivl); log('Response observer torn down (context invalidated)'); };

    mo = new MutationObserver(debounce(check, 2000));
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    ivl = setInterval(check, 3000);
    log('Response observer active');
  }

  /* ══════════════ §9  MESSAGE LISTENER ══════════════ */

  if (contextAlive()) chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    switch (msg.type) {
      case 'SEND_TEXT': {
        if (cache && cache.extensionEnabled === false) { sendResponse({ ok: false, error: 'Extension disabled' }); return; }
        const editor = q(SEL.editor);
        if (!editor) { sendResponse({ ok: false, error: 'No editor' }); return; }
        const text = (msg.text || '').trim();
        if (!text) { sendResponse({ ok: false, error: 'Empty' }); return; }
        (async () => {
          try {
            let embedding = null;
            if (cache?.activeCard && hasVectorizedEntries()) {
              try { embedding = await computeUserEmbedding(text); } catch (e) { warn('SEND_TEXT embedding err:', e); }
            }
            if (cache?.activeCard) { doInject(editor, text, embedding); }
            else { replaceEditorText(editor, text); }
            setTimeout(() => { skipHook = true; const btn = findSendButton(); if (btn) btn.click(); skipHook = false; sendResponse({ ok: true }); }, 150);
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;
      }
      case 'GET_EDITOR_TEXT': {
        const editor = q(SEL.editor);
        sendResponse({ text: editor ? (editor.innerText || '') : '' });
        break;
      }
      case 'PING': sendResponse({ ok: true, source: 'content' }); break;
    }
  });

  /* ══════════════ §10  UTILS ══════════════ */

  function debounce(fn, ms) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }

  /* ══════════════ §11  INIT ══════════════ */

  function init() {
    log('Loaded on', location.href);
    attachInterceptors();
    attachResponseObserver();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
