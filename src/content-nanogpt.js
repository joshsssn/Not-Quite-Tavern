/**
 * content-nanogpt.js — NanoGPT injection + Full SillyTavern Lorebook Engine  (v3)
 *
 * Mirror of content.js features, tailored for https://nano-gpt.com/
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

  const TAG = '[RP·NanoGPT]';
  const log  = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  /** Returns false once the extension has been reloaded/invalidated. */
  const contextAlive = () => !!chrome.runtime?.id;

  /* ══════════════ §1  DOM SELECTORS (NanoGPT) ══════════════ */

  const SEL = {
    editor: [
      // NanoGPT 2024-2026 — primary textarea
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="Ask" i]',
      'textarea[placeholder*="Type" i]',
      'textarea[placeholder*="chat" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea[placeholder*="Send" i]',
      'textarea[placeholder*="Write" i]',
      'textarea[aria-label*="message" i]',
      'textarea[aria-label*="prompt" i]',
      'textarea[aria-label*="chat" i]',
      // React/Next.js common patterns
      'form textarea',
      '.chat-input textarea',
      '[class*="chat"] textarea',
      '[class*="input"] textarea',
      '[class*="prompt"] textarea',
      '[class*="message-input"] textarea',
      '[class*="composer"] textarea',
      '[class*="ChatInput"] textarea',
      // ContentEditable fallbacks (some chat UIs)
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="plaintext-only"][role="textbox"]',
      '[data-placeholder][contenteditable="true"]',
      'div[contenteditable="true"][data-placeholder]',
      '[role="textbox"][contenteditable]',
      // Generic textarea fallback
      'textarea',
      // Last resort — contenteditable near bottom
      '[class*="bottom"] div[contenteditable="true"]',
      '[class*="footer"] div[contenteditable="true"]'
    ],
    sendButton: [
      // NanoGPT / Mantine — submit button inside the form
      'form button[type="submit"]',
      'form button[aria-label*="Send" i]',
      'form button[aria-label*="submit" i]',
      'button[aria-label*="Send" i]:not([aria-label*="Voice" i])',
      'button[aria-label*="send" i]:not([aria-label*="Voice" i])',
      'button[aria-label*="Submit" i]',
      'button[aria-label*="Envoyer" i]',
      'button[title*="Send" i]',
      'button[title*="send" i]',
      'button[type="submit"]',
      // React / Next.js patterns
      '[class*="send"] button',
      '[class*="submit"] button',
      'button[class*="send" i]',
      'button[class*="submit" i]',
      'button[data-testid*="send" i]',
      'button[data-testid*="submit" i]',
      // Icon buttons near the input — prefer the last one in the form
      'form button:last-of-type',
      'form button svg',
    ],
    modelTurn: [
      // Explicit role attributes (safest)
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-turn-role="assistant"]',
      '[data-turn-role="model"]',
      '[data-source-type="assistant"]',
      '[data-source-type="model"]',
      // Specific class patterns (not overly broad)
      '[class*="bot-message"]',
      '[class*="ai-message"]',
      '[class*="assistant-message"]',
      '[class*="model-response"]',
    ],
    userTurn: [
      '[data-role="user"]',
      '[data-message-author-role="user"]',
      '[data-turn-role="user"]',
      '[data-source-type="user"]',
      '[class*="user-message"]',
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
    if (fromSel) {
      // If we matched 'form button svg', return the parent button
      if (fromSel.tagName === 'svg' || fromSel.tagName === 'SVG') {
        const btn = fromSel.closest('button');
        if (btn) { log('Send button found via SVG parent'); return btn; }
      }
      log('Send button found via selector');
      return fromSel;
    }
    // Proximity search — find button near the editor
    const editor = q(SEL.editor);
    if (!editor) { warn('findSendButton: no editor found'); return null; }
    const container = editor.closest('form') || editor.closest('[class*="input-area"]') ||
      editor.closest('[class*="chat-input"]') || editor.closest('[class*="bottom"]') ||
      editor.closest('[class*="footer"]') || editor.closest('[class*="prompt"]') ||
      editor.closest('[class*="composer"]') ||
      editor.parentElement?.parentElement?.parentElement?.parentElement;
    if (!container) { warn('findSendButton: no container'); return null; }
    // Pass 1: label match
    for (const btn of container.querySelectorAll('button')) {
      const lbl = (btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent || '').toLowerCase();
      if (lbl.includes('send') || lbl.includes('envoyer') || lbl.includes('submit')) { log('Send button found via label:', lbl); return btn; }
    }
    // Pass 2: type=submit
    for (const btn of container.querySelectorAll('button[type="submit"]')) {
      return btn;
    }
    // Pass 3: icon button
    for (const btn of container.querySelectorAll('button')) {
      if (btn.querySelector('svg, [class*="icon"]')) return btn;
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

      // Vectorized
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
        if (e.triggerMode === 'vectorized') continue;
        if (triggered.has(e.id)) continue;
      }

      // Keyword (default)
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
        newTS[e.id] = { ...newTS[e.id], stickyUntil: totalMsg + e.sticky };
        delete newTS[e.id]?.cooldownUntil;
      } else if (e.cooldown > 0) {
        newTS[e.id] = { ...newTS[e.id], cooldownUntil: totalMsg + 1 + e.cooldown };
      }
    }

    for (const [id, st] of Object.entries(newTS)) {
      if (!st.stickyUntil) continue;
      if (totalMsg > st.stickyUntil && !triggered.has(id)) {
        const ent = entryMap.get(id);
        if (ent && ent.cooldown > 0) {
          newTS[id] = { cooldownUntil: totalMsg + ent.cooldown };
        } else {
          delete newTS[id];
        }
      }
    }

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

    const byPos = { before_char: [], after_char: [], at_depth: [], an_top: [], an_bottom: [] };
    for (const e of matched) byPos[e.position || 'after_char']?.push(e) ?? byPos.after_char.push(e);

    const parts = [];

    if (byPos.before_char.length) {
      parts.push(`<lorebook position="before_char">\n${byPos.before_char.map(e => `[${(e.keyword||[]).join(', ')}]: ${e.content}`).join('\n')}\n</lorebook>`);
    }

    const cl = [card.systemPrompt, card.name ? `Name: ${card.name}` : '', card.description ? `Description: ${card.description}` : '',
      card.personality ? `Personality: ${card.personality}` : '', card.scenario ? `Scenario: ${card.scenario}` : ''].filter(Boolean);
    parts.push(`<character>\n${cl.join('\n')}\n</character>`);

    if (byPos.after_char.length) {
      parts.push(`<lorebook>\n${byPos.after_char.map(e => `[${(e.keyword||[]).join(', ')}]: ${e.content}`).join('\n')}\n</lorebook>`);
    }

    const anParts = [];
    if (byPos.an_top.length) anParts.push(byPos.an_top.map(e => e.content).join('\n'));
    if (cache.authorNote) anParts.push(cache.authorNote);
    if (byPos.an_bottom.length) anParts.push(byPos.an_bottom.map(e => e.content).join('\n'));
    if (anParts.length) parts.push(`<author_note>\n${anParts.join('\n')}\n</author_note>`);

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
   * NanoGPT typically uses <textarea> so the textarea path is primary.
   */
  function replaceEditorText(editor, text) {
    const isTextarea = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';

    if (isTextarea) {
      // Textarea path: use native setter to bypass React controlled component
      const nativeSetter = Object.getOwnPropertyDescriptor(
        editor.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) nativeSetter.call(editor, text);
      else editor.value = text;

      // Fire React-compatible events
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));

      // React 16+ synthetic event trigger
      const tracker = editor._valueTracker;
      if (tracker) { tracker.setValue(''); }
      editor.dispatchEvent(new Event('input', { bubbles: true }));

      log('replaceEditorText: textarea path (React-aware)');
      return;
    }

    // ContentEditable path
    editor.focus();

    // Strategy 1: execCommand
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

    // Strategy 2: Clipboard paste simulation
    try {
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
      const current = (editor.innerText || editor.textContent || '').trim();
      if (current.includes(text.substring(0, 30))) {
        log('replaceEditorText: paste simulation succeeded');
        return;
      }
    } catch (e) { warn('Paste simulation failed:', e.message); }

    // Strategy 3: InputEvent fallback
    try {
      editor.textContent = '';
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true, cancelable: true, composed: true
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true, composed: true
      }));
      const p = document.createElement('p');
      p.textContent = text;
      editor.appendChild(p);
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

  function hasVectorizedEntries() {
    if (!cache) return false;
    if (cache.loreDefaultTriggerMode === 'vectorized') return true;
    return (cache.loreBooks || []).some(b => b.enabled &&
      (b.entries || []).some(e => e.enabled && e.triggerMode === 'vectorized' && (e.embeddings || e.embedding)));
  }

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

  /** Save a user message to chatHistory (interceptor-based, deduped). */
  async function recordUserMessage(raw) {
    if (!raw || raw.length < 1) return;
    const norm = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!norm) return;
    try {
      if (!contextAlive()) return;
      const d = await storageGet(['chatHistory', 'totalMessageCount']);
      const hist = d.chatHistory || [];
      // Dedup: skip if the last user entry in history matches
      for (let i = hist.length - 1; i >= Math.max(0, hist.length - 3); i--) {
        if (hist[i].role !== 'user') continue;
        const exNorm = hist[i].text.toLowerCase().replace(/\s+/g, ' ').trim();
        if (exNorm === norm) return; // exact dupe
        break; // only check last user entry
      }
      hist.push({ role: 'user', text: raw, timestamp: Date.now() });
      const newT = (d.totalMessageCount || 0) + 1;
      await storageSet({ chatHistory: hist, totalMessageCount: newT });
      if (cache) { cache.chatHistory = hist; cache.totalMessageCount = newT; }
      log('\u2713 User message recorded:', raw.substring(0, 60));
    } catch (e) { warn('recordUserMessage error:', e); }
  }

  /** Core inject: scan + assemble + replace + save history */
  function doInject(editor, raw, embedding) {
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

  /** Sync hook (keyword-only) */
  function preSubmitHookSync() {
    if (hookBusy || skipHook) return;
    const editor = q(SEL.editor);
    if (!editor) { warn('preSubmitHookSync: editor NOT FOUND'); return; }
    const raw = (editor.value || editor.innerText || editor.textContent || '').trim();
    if (!raw) { warn('preSubmitHookSync: editor is empty'); return; }
    if (!cache || !cache.activeCard) { log('No active card — pass-through'); return; }

    hookBusy = true;
    log('preSubmitHookSync — raw:', raw.substring(0, 60));
    const assembled = doInject(editor, raw, null);
    if (assembled) log('✓ Injected (sync):', raw.substring(0, 60));
    else warn('✗ Injection produced no output');
    setTimeout(() => { hookBusy = false; }, 600);
  }

  /** Async submit: compute embedding, inject, then re-trigger send */
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
    skipHook = true;
    triggerSend();
    setTimeout(() => { skipHook = false; hookBusy = false; }, 600);
  }

  /* ══════════════ §7  INTERCEPTORS ══════════════ */

  /** Read text from editor (textarea or contenteditable) */
  function readEditor(editor) {
    if (!editor) return '';
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') return (editor.value || '').trim();
    return (editor.innerText || editor.textContent || '').trim();
  }

  function attachInterceptors() {
    const hookBtn = btn => {
      if (!btn || btn.__rpHooked) return;
      btn.__rpHooked = true;

      const handler = e => {
        if (cache && cache.extensionEnabled === false) return;
        if (skipHook || hookBusy) return;
        const editor = q(SEL.editor);
        if (!editor) { warn('Hook fired but editor NOT FOUND'); return; }
        const raw = readEditor(editor);
        if (!raw) { log('Hook fired but editor is empty'); return; }

        // Always record the user message
        recordUserMessage(raw);

        if (!cache || !cache.activeCard) { log('Hook fired but no active card — pass-through'); return; }

        log('Hook fired! raw:', raw.substring(0, 40), '| vectorized:', hasVectorizedEntries());

        if (hasVectorizedEntries()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          asyncSubmit(editor, raw, () => btn.click());
        } else {
          preSubmitHookSync();
        }
      };

      btn.addEventListener('pointerdown', handler, true);
      btn.addEventListener('mousedown', handler, true);
      btn.addEventListener('click', handler, true);
      log('✓ Send button hooked:', btn.tagName, btn.className?.substring(0, 30), btn.getAttribute('aria-label'));
    };

    // Also intercept form submission (NanoGPT likely uses a <form>)
    function hookForm() {
      const forms = document.querySelectorAll('form');
      forms.forEach(form => {
        if (form.__rpHooked) return;
        form.__rpHooked = true;
        form.addEventListener('submit', e => {
          if (cache && cache.extensionEnabled === false) return;
          if (skipHook || hookBusy) return;
          const editor = q(SEL.editor);
          if (!editor) return;
          const raw = readEditor(editor);
          if (!raw) return;

          // Always record the user message
          recordUserMessage(raw);

          if (!cache || !cache.activeCard) return;

          log('Form submit hook! raw:', raw.substring(0, 40));

          if (hasVectorizedEntries()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            asyncSubmit(editor, raw, () => {
              skipHook = true;
              form.requestSubmit ? form.requestSubmit() : form.submit();
              setTimeout(() => { skipHook = false; }, 100);
            });
          } else {
            preSubmitHookSync();
          }
        }, true);
        log('✓ Form hooked');
      });
    }

    new MutationObserver(() => {
      hookBtn(findSendButton());
      hookForm();
    }).observe(document.body, { childList: true, subtree: true });
    hookBtn(findSendButton());
    hookForm();

    /* Diagnostic */
    setTimeout(() => {
      const ed = q(SEL.editor);
      const btn = findSendButton();
      log('Diag: editor =', ed?.tagName, ed?.className?.substring(0, 40), '| sendBtn =', btn?.tagName, btn?.className?.substring(0, 30));
      if (!ed) warn('DIAGNOSTIC: Editor element NOT FOUND — selectors may need updating for NanoGPT.');
      if (!btn) warn('DIAGNOSTIC: Send button NOT FOUND — selectors may need updating for NanoGPT.');
    }, 3000);

    // Enter key hook
    document.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (cache && cache.extensionEnabled === false) return;
      if (skipHook || hookBusy) return;
      const editor = q(SEL.editor);
      if (!editor) return;
      const a = document.activeElement;
      if (a !== editor && !editor.contains(a)) return;

      const raw = readEditor(editor);
      if (!raw) return;

      // Always record the user message
      recordUserMessage(raw);

      if (!cache || !cache.activeCard) return;

      log('Enter key hook! raw:', raw.substring(0, 40));

      if (hasVectorizedEntries()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        asyncSubmit(editor, raw, () => {
          const btn = findSendButton();
          if (btn) btn.click();
          else {
            const form = editor.closest('form');
            if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
          }
        });
      } else {
        preSubmitHookSync();
      }
    }, true);
    log('Interceptors attached');
  }

  /* ══════════════ §8  RESPONSE OBSERVER ══════════════ */

  /**
   * NanoGPT response observer — conversation-text parser v4.
   *
   * NanoGPT renders conversation text with these markers:
   *   "You | [user msg] [ModelName] | [time?] | Cost: [tier] [Reasoning?] [response] …"
   *
   * UI chrome text like "Chat Free model 8% Free model active. Add balance…"
   * leaks into the conversation text and must be stripped.
   *
   * Strategy:
   *   1. Read full conversation text, split on "You |" to get per-exchange segments.
   *   2. Inside each segment, find the model header and extract the response.
   *   3. CLEAN the response: strip trailing NanoGPT UI artifacts.
   *   4. NORMALIZE for dedup: compare cleaned text to avoid double-saving
   *      when the raw text differs only in trailing UI junk.
   *   5. Only capture ONE new turn per cycle (the latest), require stability.
   */
  function attachResponseObserver() {

    /**
     * Model-header regex — matches:
     *   "Free model | | Cost: Free"
     *   "GPT-4o | 7:43 AM | Cost: $0.002"
     *   "Claude 3.5 Sonnet | 8:01 PM | Cost: Free"
     *
     * Model-name portion uses [\w .\-+\/] (NO punctuation like !?;:,)
     * so that user messages containing punctuation stop the match and
     * prevent "AM tu peux me tutoyer! Free model |..." from being
     * swallowed as one giant model name.
     */
    const MODEL_HEADER_RE = /[A-Za-z][\w .\-+\/]{0,30}\s*\|\s*[^|]{0,25}\|\s*Cost:\s*\S+/g;

    /** Get the full innerText of NanoGPT's conversation area. */
    function getConversationText() {
      const candidates = Array.from(document.querySelectorAll(
        'main, [role="main"], [class*="conversation"], [class*="chat-area"], ' +
        '[class*="messages"], [class*="MessageList"], [class*="thread"], ' +
        '[id*="chat"], [id*="messages"]'
      ));
      candidates.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      for (const el of candidates) {
        const t = (el.innerText || '').trim();
        if (t.length > 30) return t;
      }
      return (document.body.innerText || '').trim();
    }

    /**
     * Strip NanoGPT UI artifacts that leak into captured text.
     * These appear at the END of response segments because the split
     * boundary lands on the next "You |" which is past the UI chrome.
     *
     * Known patterns (from screenshots):
     *   "Chat Free model 8%"
     *   "Chat Free model 10%"
     *   "Free model active. Add balance for top models."
     *   "Free model active. Add balanc..."
     *   "Topic Salut ! Sync Preset Standard"
     *   standalone percentages "8%"
     */
    function cleanResponse(raw) {
      let t = raw;

      // Remove "Reasoning" CoT label at start
      t = t.replace(/^Reasoning\s*/i, '').trim();

      // Remove trailing UI: "Chat [ModelName] [N%] [Free model active...] [Add balance...]"
      // This covers "Chat Free model 8% Free model active. Add balance for top models."
      t = t.replace(/\s*Chat\s+(?:Free\s+model|[A-Za-z][\w .+-]{0,30})\s*\d*%?[\s\S]*$/i, '');

      // If "Chat" strip didn't catch it, try individual trailing patterns
      t = t.replace(/\s*Free\s+model\s+active[\s\S]*$/i, '');
      t = t.replace(/\s*Add\s+balance[\s\S]*$/i, '');
      t = t.replace(/\s*Free\s+model\s*\d*%?\s*$/i, '');
      t = t.replace(/\s*\d+%\s*$/i, '');

      // Remove leading "Topic ... Sync Preset Standard" (NanoGPT topic bar)
      t = t.replace(/^Topic\s+.*?Sync\s+Preset\s+Standard\s*/i, '');

      return t.trim();
    }

    /** Normalize text for dedup comparison: clean + lowercase + collapse whitespace. */
    function normalize(text) {
      return cleanResponse(text).toLowerCase().replace(/\s+/g, ' ').trim();
    }

    /**
     * Parse model turns from full conversation text.
     * Returns array of { raw, clean } objects in chronological order.
     */
    function parseModelTurns(fullText) {
      const turns = [];
      const segments = fullText.split(/\bYou\s*\|/);

      for (const seg of segments) {
        if (!seg || seg.trim().length < 5) continue;

        MODEL_HEADER_RE.lastIndex = 0;
        const hm = MODEL_HEADER_RE.exec(seg);
        if (!hm) continue;

        const raw = seg.slice(hm.index + hm[0].length).trim();
        const clean = cleanResponse(raw);

        if (clean.length >= 2) turns.push({ raw, clean });
      }
      return turns;
    }

    /**
     * Clean user text: strip timestamps, reasoning leaks, and UI artifacts.
     * Raw user segment looks like:
     *   "8:32 AM Surprend moi ! Free model Reasoning. The user says..."
     *   "8:31"
     *   "salut !"
     * We want only: "Surprend moi !", "salut !"
     */
    function cleanUserText(raw) {
      let t = raw;

      // Strip leading timestamp: "8:32 AM ", "8:32", "08:31:40", etc.
      t = t.replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?\s*/i, '').trim();

      // Strip everything from "Free model" onward (reasoning, thinking, UI artifacts)
      t = t.replace(/\s*Free\s+model[\s\S]*/i, '').trim();

      // Strip everything from "Reasoning" onward
      t = t.replace(/\s*Reasoning[\s\S]*/i, '').trim();

      // Strip everything from "Thinking" onward
      t = t.replace(/\s*Thinking[\s\S]*/i, '').trim();

      // Strip "Chat" + model name + percentage + UI
      t = t.replace(/\s*Chat\s+[\s\S]*/i, '').trim();

      // Strip trailing "Add balance..." / "Free model active..."
      t = t.replace(/\s*Add\s+balance[\s\S]*/i, '').trim();
      t = t.replace(/\s*\d+%\s*$/i, '').trim();

      return t;
    }

    /** Normalize user text for dedup. */
    function normalizeUser(text) {
      return cleanUserText(text).toLowerCase().replace(/\s+/g, ' ').trim();
    }

    /**
     * Parse user turns from full conversation text.
     * Format: "You | [timestamp?] [user message] [Free model Reasoning...?] [ModelHeader...]"
     * Returns array of { raw, clean } objects in chronological order.
     */
    function parseUserTurns(fullText) {
      const turns = [];
      const segments = fullText.split(/\bYou\s*\|/);

      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg || seg.trim().length < 1) continue;

        // Use '| Cost:' as unambiguous anchor, then walk backwards to find
        // the model-name boundary (stops at punctuation like ! ? , ; : etc.)
        const costIdx = seg.search(/\|\s*Cost:/i);
        let userRaw;
        if (costIdx >= 0) {
          // Find the time-separator pipe: the last '|' before '| Cost:'
          const beforeCost = seg.slice(0, costIdx);
          const timePipe = beforeCost.lastIndexOf('|');
          if (timePipe >= 0) {
            // Model name is at the end of text before the time pipe.
            // Scan backwards from timePipe, stopping at user-text punctuation.
            const pre = seg.slice(0, timePipe).trimEnd();
            let nameStart = pre.length;
            for (let j = pre.length - 1; j >= 0; j--) {
              if (/[\w .\-+\/]/.test(pre[j])) nameStart = j;
              else break;
            }
            userRaw = pre.slice(0, nameStart).trim();
          } else {
            userRaw = seg.trim();
          }
        } else {
          userRaw = seg.trim();
        }
        const clean = cleanUserText(userRaw);

        if (clean.length >= 2) turns.push({ raw: userRaw, clean });
      }
      return turns;
    }

    // Dedup set stores NORMALIZED keys so slight variations don't create duplicates
    const capturedModelNorms = new Set();
    const capturedUserNorms  = new Set();

    /**
     * Check if a normalized user message is a duplicate.
     * Only considers prefix relationships when the shorter string is at least
     * 70% of the longer string's length (prevents 'dit moi' being blocked
     * by 'dit moi une phrase courte...').
     */
    function checkUserDuplicate(norm) {
      if (capturedUserNorms.has(norm)) return true;
      for (const ex of capturedUserNorms) {
        const shorter = Math.min(ex.length, norm.length);
        const longer  = Math.max(ex.length, norm.length);
        // Only consider prefix relationship when lengths are similar (>= 65%).
        // Prevents 'dit moi' (7 chars) from matching
        // 'dit moi une phrase courte...' (50+ chars).
        if (shorter / longer < 0.65) continue;
        if (ex.startsWith(norm)) return true; // new is truncated prefix → skip
        if (norm.startsWith(ex)) {
          // new is longer/fuller — replace existing with the fuller version
          capturedUserNorms.delete(ex);
          capturedUserNorms.add(norm);
          return false; // save the fuller version
        }
      }
      return false;
    }
    let pendingClean  = '';
    let pendingStable = 0;
    let wasDisabled   = false;
    let teardown;

    /** Save a cleaned user message to chatHistory (deduped via normalized text + prefix check). */
    async function saveUserMsg(cleanText) {
      const norm = cleanText.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!norm || norm.length < 1) return;
      if (checkUserDuplicate(norm)) return;
      capturedUserNorms.add(norm);
      try {
        if (!contextAlive()) return;
        const d = await storageGet(['chatHistory', 'totalMessageCount']);
        const hist = d.chatHistory || [];
        // Skip if the last user entry already matches (prefix-safe)
        const lastUser = [...hist].reverse().find(e => e.role === 'user');
        if (lastUser) {
          const lastNorm = lastUser.text.toLowerCase().replace(/\s+/g, ' ').trim();
          if (lastNorm === norm) return;
          // Prefix dedup only when lengths are similar
          const sLen = Math.min(lastNorm.length, norm.length);
          const lLen = Math.max(lastNorm.length, norm.length);
          if (sLen / lLen >= 0.65 && (lastNorm.startsWith(norm) || norm.startsWith(lastNorm))) return;
        }
        hist.push({ role: 'user', text: cleanText, timestamp: Date.now() });
        const newT = (d.totalMessageCount || 0) + 1;
        await storageSet({ chatHistory: hist, totalMessageCount: newT });
        if (cache) { cache.chatHistory = hist; cache.totalMessageCount = newT; }
        log('✓ User message saved:', cleanText.substring(0, 60));
      } catch (e) { warn('User msg save error:', e); }
    }

    const check = async () => {
      if (!contextAlive()) { teardown?.(); return; }

      if (cache?.extensionEnabled === false) {
        if (!wasDisabled) {
          wasDisabled = true;
          pendingClean = ''; pendingStable = 0;
          log('Response observer paused (extension disabled)');
        }
        return;
      }
      if (wasDisabled) { wasDisabled = false; log('Response observer resumed'); }

      // Don't capture while streaming
      if (document.querySelector(
        '[class*="streaming"], [class*="generating"], [class*="typing"], ' +
        '[class*="spinner"], [aria-busy="true"], .loading-indicator'
      )) { pendingStable = 0; return; }

      const convText = getConversationText();

      // --- User turns ---
      const userTurns = parseUserTurns(convText);
      for (const ut of userTurns) {
        const norm = normalizeUser(ut.raw);
        if (norm && !checkUserDuplicate(norm)) {
          await saveUserMsg(ut.clean);
        }
      }

      // --- Model turns ---
      const allTurns = parseModelTurns(convText);

      // Find turns whose normalized form is NOT yet captured
      const newTurns = allTurns.filter(t => !capturedModelNorms.has(normalize(t.clean)));

      if (newTurns.length === 0) {
        // Nothing truly new — check if pending is still present & stable
        if (pendingClean) {
          const stillPresent = allTurns.some(t => t.clean === pendingClean);
          if (stillPresent) pendingStable++;
          else { pendingClean = ''; pendingStable = 0; }
        }
      } else {
        // Only consider the LATEST (last) new turn
        const latest = newTurns[newTurns.length - 1].clean;
        if (latest !== pendingClean) {
          pendingClean = latest; pendingStable = 0;
        } else {
          pendingStable++;
        }
      }

      // Require 2 consecutive stable checks
      if (!pendingClean || pendingStable < 2) return;

      // === Stable — save ===
      const text = pendingClean;
      pendingClean = ''; pendingStable = 0;
      capturedModelNorms.add(normalize(text));

      log('New model reply (' + text.length + ' chars):', text.substring(0, 100));

      try {
        if (!contextAlive()) { teardown?.(); return; }
        const d = await storageGet(['chatHistory', 'repliesSinceLastSummary', 'memorySummaryInterval', 'totalMessageCount']);
        const hist = d.chatHistory || [];

        // Skip if last entry already has this text (extra safety)
        const lastH = hist[hist.length - 1];
        if (lastH && lastH.role === 'model' && normalize(lastH.text) === normalize(text)) return;

        hist.push({ role: 'model', text, timestamp: Date.now() });
        const cnt  = (d.repliesSinceLastSummary || 0) + 1;
        const newT = (d.totalMessageCount || 0) + 1;
        await storageSet({ chatHistory: hist, repliesSinceLastSummary: cnt, totalMessageCount: newT });
        if (cache) { cache.chatHistory = hist; cache.repliesSinceLastSummary = cnt; cache.totalMessageCount = newT; }
        log(`✓ Model reply saved (#${cnt}/${d.memorySummaryInterval || 10})`);

        if (cnt >= (d.memorySummaryInterval || 10)) {
          log('Auto-memory triggered');
          if (contextAlive()) chrome.runtime.sendMessage({ type: 'SUMMARIZE_MEMORY' }).catch(() => {});
          await storageSet({ repliesSinceLastSummary: 0 });
          if (cache) cache.repliesSinceLastSummary = 0;
        }
      } catch (e) {
        if (!contextAlive()) { teardown?.(); return; }
        warn('Response save error:', e);
      }
    };

    let mo, ivl;
    teardown = () => { try { mo?.disconnect(); } catch {} clearInterval(ivl); log('Response observer torn down'); };

    // Baseline: parse existing turns so we don't re-save old history
    setTimeout(() => {
      const convText = getConversationText();
      const modelTurns = parseModelTurns(convText);
      modelTurns.forEach(t => capturedModelNorms.add(normalize(t.clean)));
      const userTurns = parseUserTurns(convText);
      userTurns.forEach(t => {
        const n = normalizeUser(t.raw);
        if (n) capturedUserNorms.add(n);
      });
      log('Baseline:', modelTurns.length, 'model +', userTurns.length, 'user turns indexed');
    }, 3000);

    mo = new MutationObserver(debounce(check, 1500));
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    ivl = setInterval(check, 2500);
    log('Response observer active (v4 — clean + normalize dedup)');
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
            setTimeout(() => {
              skipHook = true;
              const btn = findSendButton();
              if (btn) btn.click();
              else {
                const form = editor.closest('form');
                if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
              }
              skipHook = false;
              sendResponse({ ok: true });
            }, 150);
          } catch (err) { sendResponse({ ok: false, error: err.message }); }
        })();
        return true;
      }
      case 'GET_EDITOR_TEXT': {
        const editor = q(SEL.editor);
        sendResponse({ text: editor ? readEditor(editor) : '' });
        break;
      }
      case 'PING': sendResponse({ ok: true, source: 'content-nanogpt' }); break;
    }
  });

  /* ══════════════ §10  UTILS ══════════════ */

  function debounce(fn, ms) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }

  /* ══════════════ §11  INIT ══════════════ */

  function init() {
    log('Loaded on', location.href);
    attachInterceptors();
    attachResponseObserver();
    
    // Diagnostic at startup
    setTimeout(() => {
      const ed = q(SEL.editor);
      const btn = findSendButton();
      log('Diag: editor =', ed?.tagName, ed?.className?.substring(0, 50),
           '| sendBtn =', btn?.tagName, btn?.className?.substring(0, 40));
      if (!ed) warn('⚠️ Editor NOT FOUND');
      if (!btn) warn('⚠️ Send button NOT FOUND');
    }, 2000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
