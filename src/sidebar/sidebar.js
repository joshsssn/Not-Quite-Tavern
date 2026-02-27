/**
 * sidebar.js — v4 — Full-feature sidebar with view/edit modes
 */
(function () {
  'use strict';

  /* ═══════ STATE ═══════ */
  let D = {};
  let editCardId = null;
  let editBookId = null;
  let editEntryId = null;
  let cardEditorOpen = false;
  let entryEditorOpen = false;

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

  /**
   * Build an array of short texts to embed for an entry.
   * The model (MiniLM-L12-v2) has a 128-token (~500 char) limit.
   * We split into: keywords-only chunk + content chunks of ~400 chars.
   * At match time we use the MAX similarity across all chunks.
   */
  function buildEmbedTexts(entry) {
    const texts = [];
    const kw = (entry.keyword || []).join(', ');
    const content = (entry.content || '').trim();
    // Chunk 1: keywords only (catches direct keyword-like queries)
    if (kw) texts.push(kw);
    // Content chunks: ~400 chars each, 100 char overlap
    if (content) {
      const CHUNK = 400, OVERLAP = 100;
      for (let i = 0; i < content.length; i += CHUNK - OVERLAP) {
        texts.push(content.substring(i, i + CHUNK));
        if (texts.length >= 6) break; // cap total chunks
      }
    }
    if (!texts.length) texts.push('empty entry');
    return texts;
  }

  /** Get the effective embeddings array from an entry (handles legacy + new format) */
  function getEntryEmbeddings(entry) {
    if (entry.embeddings && entry.embeddings.length) return entry.embeddings;
    if (entry.embedding) return [entry.embedding];
    return null;
  }

  /** Compute max cosine similarity of a query embedding against an entry's chunk embeddings */
  function maxCosineSim(queryEmb, entryEmbeddings) {
    let best = 0;
    for (const emb of entryEmbeddings) {
      const s = cosineSim(queryEmb, emb);
      if (s > best) best = s;
    }
    return best;
  }

  /** Vectorize a single entry: compute multi-chunk embeddings. Returns true on success. */
  async function vectorizeEntry(entry) {
    const texts = buildEmbedTexts(entry);
    const embeddings = [];
    for (const text of texts) {
      const emb = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'COMPUTE_EMBEDDING', text }, r => {
          resolve(r?.ok ? r.embedding : null);
        });
      });
      if (emb) embeddings.push(emb);
    }
    if (embeddings.length) {
      entry.embeddings = embeddings;
      entry.embedding = null; // clear legacy single
      return true;
    }
    return false;
  }

  /* ═══════ TOAST ═══════ */
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  /* ═══════ TABS ═══════ */
  $$('.tab-bar button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-bar button').forEach(b => b.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#panel-${btn.dataset.tab}`).classList.add('active');
    });
  });

  /* ═══════ LOAD ═══════ */
  async function load() {
    D = await storageGetAll();
    renderMem();
    renderCards();
    renderBooks();
    renderNotes();
    renderSettings();
    renderNotebook();
    renderInspector();
    renderHistory();
    renderTokens();
  }

  /* ═══════════════════════════════════════════
     MEM COUNTER
     ═══════════════════════════════════════════ */
  function renderMem() {
    $('#memCur').textContent = D.repliesSinceLastSummary || 0;
    $('#memMax').textContent = D.memorySummaryInterval || 10;
    renderModeToggle();
    renderMasterToggle();
  }

  /* ═════════════════════════════════════════════
     MASTER TOGGLE (ON/OFF)
     ═════════════════════════════════════════════ */
  function renderMasterToggle() {
    const isOn = D.extensionEnabled !== false;
    const knob = $('#masterKnob');
    const status = $('#masterStatus');
    const toggle = $('#masterToggle');

    if (!knob || !status) return;

    if (isOn) {
      knob.style.background = 'var(--green)';
      knob.style.boxShadow = '0 0 8px var(--green)';
      status.textContent = 'ON';
      status.style.color = 'var(--text)';
      toggle.style.borderColor = 'var(--green)';
    } else {
      knob.style.background = 'var(--text3)';
      knob.style.boxShadow = 'none';
      status.textContent = 'OFF';
      status.style.color = 'var(--text3)';
      toggle.style.borderColor = 'var(--border)';
    }
  }

  $('#masterToggle')?.addEventListener('click', async () => {
    const newState = D.extensionEnabled === false; // current is false? then true
    D.extensionEnabled = newState;
    await storageSet({ extensionEnabled: newState });
    renderMasterToggle();
    toast(newState ? '🟢 Extension ENABLED' : '🔴 Extension DISABLED');
  });

  /* ═════════════════════════════════════════════
     MODE TOGGLE (🔑 keyword ↔ 🧠 vectorized)
     ═════════════════════════════════════════════ */
  function renderModeToggle() {
    const mode = D.loreDefaultTriggerMode || 'keyword';
    $$('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  }
  $$('#modeToggle .mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      D.loreDefaultTriggerMode = mode;
      await storageSet({ loreDefaultTriggerMode: mode });
      renderModeToggle();
      toast(mode === 'vectorized' ? '🧠 Vector mode active' : '🔑 Keyword mode active');

      // Auto-vectorize all enabled entries without embeddings when switching to vector mode
      if (mode === 'vectorized') {
        const toVec = (D.loreBooks || [])
          .filter(b => b.enabled)
          .flatMap(b => b.entries || [])
          .filter(e => e.enabled && !getEntryEmbeddings(e) && (e.content || (e.keyword || []).length));
        if (toVec.length > 0) {
          toast(`⏳ Auto-vectorizing ${toVec.length} entries (multi-chunk)…`);
          let done = 0, failed = 0;
          for (const entry of toVec) {
            const ok = await vectorizeEntry(entry);
            if (ok) {
              if (entry.triggerMode === 'keyword') entry.triggerMode = 'vectorized';
              done++;
            } else { failed++; }
          }
          await storageSet({ loreBooks: D.loreBooks });
          toast(`✅ Auto-vectorized ${done} entries${failed ? ` (❌ ${failed} failed)` : ''}`);
          renderBooks();
        }
      }
    });
  });

  $('#btnReset').addEventListener('click', () => {
    if (!confirm('Reset conversation? Clears chat history, counters & timed state.')) return;
    chrome.runtime.sendMessage({ type: 'RESET_CONVERSATION' }, () => { toast('Conversation reset'); load(); });
  });
  $('#btnForceMem').addEventListener('click', () => {
    toast('Generating memory...');
    chrome.runtime.sendMessage({ type: 'SUMMARIZE_MEMORY' }, r => {
      toast(r?.ok ? `✅ ${r.bookName} (${r.count} entries)` : `❌ ${r?.error}`);
      load();
    });
  });

  /* ═══════════════════════════════════════════
     §1 — CHARACTER CARDS (view + edit)
     ═══════════════════════════════════════════ */

  function renderCards() {
    const el = $('#cardsList');
    el.innerHTML = '';
    const cards = D.characterCards || [];

    if (!cards.length) {
      el.innerHTML = '<div class="empty"><div class="emoji">🎭</div>No character cards yet.<br>Create one or import a JSON.</div>';
      return;
    }

    cards.forEach(c => {
      const isActive = c.id === D.activeCard;
      const div = document.createElement('div');
      div.className = 'card-item' + (isActive ? ' active' : '');
      div.innerHTML = `
        <div class="card-header">
          <span class="card-name">${esc(c.name || 'Unnamed')}</span>
          ${isActive ? '<span class="badge on">ACTIVE</span>' : ''}
          <div class="card-actions">
            <button class="icon-btn act-toggle" title="${isActive ? 'Deselect' : 'Select as active'}">${isActive ? '✕' : '✓'}</button>
            <button class="icon-btn act-edit" title="Edit">✏️</button>
          </div>
        </div>
        <div class="card-detail">
          <div class="info-line"><b>Prompt:</b> ${esc((c.systemPrompt || '').substring(0, 80))}${(c.systemPrompt||'').length > 80 ? '…' : ''}</div>
          ${c.description ? `<div class="info-line"><b>Desc:</b> ${esc(c.description.substring(0, 60))}…</div>` : ''}
          ${c.personality ? `<div class="info-line"><b>Pers:</b> ${esc(c.personality.substring(0, 60))}…</div>` : ''}
        </div>`;

      div.querySelector('.act-toggle').addEventListener('click', e => {
        e.stopPropagation();
        D.activeCard = isActive ? null : c.id;
        storageSet({ activeCard: D.activeCard }).then(() => { toast(isActive ? 'Card deselected' : `${c.name} activated`); load(); });
      });
      div.querySelector('.act-edit').addEventListener('click', e => {
        e.stopPropagation();
        editCardId = c.id;
        cardEditorOpen = true;
        showCardEditor(c);
      });
      el.appendChild(div);
    });

    // If editor was open for this card, keep it open
    if (cardEditorOpen && editCardId) {
      const c = cards.find(x => x.id === editCardId);
      if (c) showCardEditor(c);
    }
  }

  function showCardEditor(c) {
    const el = $('#cardEditor');
    el.style.display = 'block';
    el.innerHTML = `<div class="editor-pane">
      <h4>✏️ Editing: ${esc(c.name || 'Unnamed')}</h4>
      <label>Name<input id="cName" value="${esc(c.name || '')}"></label>
      <label>System Prompt<textarea id="cSystem" rows="4">${esc(c.systemPrompt || '')}</textarea></label>
      <label>Description<textarea id="cDesc" rows="2">${esc(c.description || '')}</textarea></label>
      <label>Personality<textarea id="cPersonality" rows="2">${esc(c.personality || '')}</textarea></label>
      <label>Scenario<textarea id="cScenario" rows="2">${esc(c.scenario || '')}</textarea></label>
      <label>First Message<textarea id="cFirstMsg" rows="2">${esc(c.firstMessage || '')}</textarea></label>
      <div class="row" style="margin-top:10px">
        <button class="primary" id="btnSaveCard">💾 Save</button>
        <button id="btnCloseCard">Close</button>
        <button class="danger" id="btnDeleteCard">🗑 Delete</button>
      </div>
    </div>`;

    $('#btnSaveCard').addEventListener('click', () => {
      c.name = $('#cName').value; c.systemPrompt = $('#cSystem').value;
      c.description = $('#cDesc').value; c.personality = $('#cPersonality').value;
      c.scenario = $('#cScenario').value; c.firstMessage = $('#cFirstMsg').value;
      storageSet({ characterCards: D.characterCards }).then(() => { toast('✅ Card saved'); renderCards(); renderTokens(); });
    });
    $('#btnCloseCard').addEventListener('click', () => {
      cardEditorOpen = false; editCardId = null;
      $('#cardEditor').style.display = 'none';
    });
    $('#btnDeleteCard').addEventListener('click', () => {
      if (!confirm(`Delete "${c.name}"?`)) return;
      D.characterCards = D.characterCards.filter(x => x.id !== c.id);
      if (D.activeCard === c.id) D.activeCard = null;
      cardEditorOpen = false; editCardId = null;
      $('#cardEditor').style.display = 'none';
      storageSet({ characterCards: D.characterCards, activeCard: D.activeCard }).then(() => { toast('Card deleted'); load(); });
    });
  }

  $('#btnNewCard').addEventListener('click', () => {
    const c = { id: uid(), name: 'New Card', systemPrompt: '', description: '', personality: '', scenario: '', firstMessage: '' };
    D.characterCards.push(c);
    editCardId = c.id; cardEditorOpen = true;
    storageSet({ characterCards: D.characterCards }).then(() => { load(); showCardEditor(c); });
  });

  $('#btnImportCard').addEventListener('click', () => $('#fileCard').click());
  $('#fileCard').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      const s = json.data || json;
      const c = { id: uid(), name: s.name || f.name, systemPrompt: s.system_prompt || s.systemPrompt || '',
        description: s.description || '', personality: s.personality || '',
        scenario: s.scenario || '', firstMessage: s.first_mes || s.firstMessage || '' };
      D.characterCards.push(c); D.activeCard = c.id;
      await storageSet({ characterCards: D.characterCards, activeCard: c.id });
      toast(`✅ Imported ${c.name}`); load();
    } catch (err) { toast('❌ ' + err.message); }
    e.target.value = '';
  });

  /* ═══════════════════════════════════════════
     §2 — LOREBOOKS (view + edit)
     ═══════════════════════════════════════════ */

  function triggerBadge(mode) {
    if (mode === 'constant') return '<span class="badge const">🔒 Constant</span>';
    if (mode === 'vectorized') return '<span class="badge vec">🧠 Vector</span>';
    return '<span class="badge kw">🔑 Keyword</span>';
  }

  function renderBooks() {
    const el = $('#booksList');
    el.innerHTML = '';
    const books = D.loreBooks || [];
    if (!books.length) {
      el.innerHTML = '<div class="empty"><div class="emoji">📚</div>No lorebooks. Create, import, or generate (WREC).</div>';
      return;
    }
    books.forEach(b => {
      const cnt = b.entries?.length || 0;
      const div = document.createElement('div');
      div.className = 'book-item';
      div.innerHTML = `<div class="book-header">
        <span class="book-name">${esc(b.name)}</span>
        <span class="badge ${b.enabled ? 'on' : 'off'}">${b.enabled ? 'ON' : 'OFF'}</span>
        <span class="badge count">${cnt}</span>
      </div>`;
      div.addEventListener('click', () => { editBookId = b.id; entryEditorOpen = false; editEntryId = null; showBookDetail(b); });
      el.appendChild(div);
    });
    renderMemBooks();
  }

  function renderMemBooks() {
    const el = $('#memBookList');
    if (!el) return;
    const mem = (D.loreBooks || []).filter(b => b.name.startsWith('🧠'));
    el.innerHTML = mem.length === 0 ? '<p style="font-size:11px;color:var(--text3)">No memory books yet.</p>'
      : mem.map(b => `<div style="font-size:11px;color:var(--text2);margin-bottom:2px">📖 ${esc(b.name)} — ${b.entries.length} entries ${b.enabled ? '✅' : '❌'}</div>`).join('');
  }

  function showBookDetail(b) {
    const el = $('#bookDetail');
    el.style.display = 'block';
    el.innerHTML = `<div class="editor-pane">
      <div class="row">
        <label style="flex:2">Book Name<input id="bName" value="${esc(b.name)}"></label>
        <label class="inline" style="flex:0;padding-top:18px"><input type="checkbox" id="bEnabled" ${b.enabled ? 'checked' : ''}> ON</label>
      </div>
      <div class="row">
        <button id="btnNewEntry">+ Entry</button>
        <button class="sm" id="btnVecAll" title="Vectorize all keyword entries that have content">🧠 Vectorize All</button>
        <button class="sm" id="btnCloseBook">Close</button>
        <button class="sm danger" id="btnDeleteBook">🗑</button>
      </div>
      <div class="sep" style="margin:8px 0"></div>
      <div id="entriesList"></div>
      <div id="entryEditor"></div>
    </div>`;

    $('#bName').addEventListener('change', () => { b.name = $('#bName').value; storageSet({ loreBooks: D.loreBooks }); });
    $('#bEnabled').addEventListener('change', () => { b.enabled = $('#bEnabled').checked; storageSet({ loreBooks: D.loreBooks }).then(() => renderBooks()); });
    $('#btnCloseBook').addEventListener('click', () => { editBookId = null; el.style.display = 'none'; });
    $('#btnDeleteBook').addEventListener('click', () => {
      if (!confirm(`Delete "${b.name}" and all entries?`)) return;
      D.loreBooks = D.loreBooks.filter(x => x.id !== b.id);
      editBookId = null; el.style.display = 'none';
      storageSet({ loreBooks: D.loreBooks }).then(() => { toast('Book deleted'); load(); });
    });
    $('#btnNewEntry').addEventListener('click', () => {
      const e = createLoreEntry();
      b.entries.push(e);
      storageSet({ loreBooks: D.loreBooks }).then(() => { renderEntries(b); editEntryId = e.id; entryEditorOpen = true; showEntryEditor(b, e); });
    });

    $('#btnVecAll').addEventListener('click', async () => {
      const toVec = b.entries.filter(e => e.enabled && (e.content || (e.keyword || []).length));
      if (!toVec.length) { toast('⚠️ No entries to vectorize'); return; }
      toast(`⏳ Vectorizing ${toVec.length} entries (multi-chunk)…`);
      let done = 0, failed = 0;
      for (const entry of toVec) {
        const ok = await vectorizeEntry(entry);
        if (ok) {
          if (entry.triggerMode === 'keyword') entry.triggerMode = 'vectorized';
          done++;
        } else { failed++; }
      }
      await storageSet({ loreBooks: D.loreBooks });
      toast(`✅ ${done} vectorized (multi-chunk)${failed ? ` (❌ ${failed} failed)` : ''}`);
      renderEntries(b);
      if (entryEditorOpen && editEntryId) {
        const e = b.entries.find(x => x.id === editEntryId);
        if (e) showEntryEditor(b, e);
      }
    });

    renderEntries(b);
    if (entryEditorOpen && editEntryId) {
      const e = b.entries.find(x => x.id === editEntryId);
      if (e) showEntryEditor(b, e);
    }
  }

  function renderEntries(book) {
    const el = document.getElementById('entriesList');
    if (!el) return;
    el.innerHTML = '';
    if (!book.entries?.length) {
      el.innerHTML = '<div class="empty" style="padding:12px"><div class="emoji">📄</div>No entries in this book.</div>';
      return;
    }
    const timedState = D.loreTimedState || {};
    const totalMsg = D.totalMessageCount || 0;

    book.entries.forEach(e => {
      const kw = (e.keyword || []).join(', ');
      const st = timedState[e.id] || {};
      const isSticky = st.stickyUntil && totalMsg <= st.stickyUntil;
      const isCooldown = st.cooldownUntil && totalMsg < st.cooldownUntil;
      const stickyLeft = isSticky ? (st.stickyUntil - totalMsg) : 0;
      const cooldownLeft = isCooldown ? (st.cooldownUntil - totalMsg) : 0;
      const isDelayed = e.delay > 0 && totalMsg < e.delay;
      const delayLeft = isDelayed ? (e.delay - totalMsg) : 0;

      const div = document.createElement('div');
      div.className = 'entry-item' + (e.enabled ? '' : ' disabled');
      div.innerHTML = `
        <div class="row" style="margin:0;gap:4px;flex-wrap:wrap">
          ${triggerBadge(e.triggerMode || 'keyword')}
          <span class="entry-kw" style="flex:1">${esc(kw || '(no keywords)')}</span>
          ${!e.enabled ? '<span class="badge off">OFF</span>' : ''}
          ${getEntryEmbeddings(e) ? '<span class="badge vec" title="Has embedding">⚡</span>' : '<span class="badge off" title="No embedding—click 🧠 to vectorize">🧠?</span>'}
          ${isSticky   ? `<span class="badge sticky" title="Sticky active">📌 ${stickyLeft}msg</span>` : ''}
          ${isCooldown ? `<span class="badge cooldown" title="On cooldown">⏸ ${cooldownLeft}msg</span>` : ''}
          ${isDelayed  ? `<span class="badge delay" title="Delay not reached yet">⏳ ${delayLeft}msg</span>` : ''}
          <button class="icon-btn vec-quick" title="Vectorize this entry" style="font-size:13px;padding:2px 5px">🧠</button>
        </div>
        <div class="entry-preview">${esc((e.content || '').substring(0, 120))}</div>`;
      div.querySelector('.vec-quick').addEventListener('click', async ev => {
        ev.stopPropagation();
        div.querySelector('.vec-quick').textContent = '⏳';
        const ok = await vectorizeEntry(e);
        if (ok) {
          if (e.triggerMode === 'keyword') e.triggerMode = 'vectorized';
          await storageSet({ loreBooks: D.loreBooks });
          toast(`✅ "${(e.keyword||[e.content||'?'])[0]}" vectorized (${e.embeddings.length} chunks)`);
          renderEntries(book);
        } else {
          toast('❌ Embed failed');
          div.querySelector('.vec-quick').textContent = '🧠';
        }
      });
      div.addEventListener('click', () => { editEntryId = e.id; entryEditorOpen = true; showEntryEditor(book, e); });
      el.appendChild(div);
    });
  }

  /* ═══════ ENTRY EDITOR — full ST fields ═══════ */

  function showEntryEditor(book, e) {
    const el = document.getElementById('entryEditor');
    if (!el) return;
    const tm = e.triggerMode || 'keyword';
    const pos = e.position || 'after_char';
    const sl = e.selectiveLogic ?? 0;

    // Build live timed status block
    const ts = (D.loreTimedState || {})[e.id] || {};
    const totalMsg = D.totalMessageCount || 0;
    const isSticky   = ts.stickyUntil   && totalMsg <= ts.stickyUntil;
    const isCooldown = ts.cooldownUntil && totalMsg <  ts.cooldownUntil;
    const isDelayed  = e.delay > 0 && totalMsg < e.delay;
    const statusItems = [];
    if (isSticky)   statusItems.push(`<span class="ts-item ts-sticky">📌 Sticky — ${ts.stickyUntil - totalMsg} msg${ts.stickyUntil - totalMsg !== 1 ? 's' : ''} left</span>`);
    if (isCooldown) statusItems.push(`<span class="ts-item ts-cooldown">⏸ Cooldown — ${ts.cooldownUntil - totalMsg} msg${ts.cooldownUntil - totalMsg !== 1 ? 's' : ''} left</span>`);
    if (isDelayed)  statusItems.push(`<span class="ts-item ts-delay">⏳ Delay — ${e.delay - totalMsg} msg${e.delay - totalMsg !== 1 ? 's' : ''} until active</span>`);
    const timedStatusHtml = statusItems.length
      ? `<div class="timed-status">🕐 Live: ${statusItems.join('')}</div>`
      : '';
    let resetTimedBtnHtml = (isSticky || isCooldown)
      ? `<button class="sm" id="btnResetTimed" style="margin-left:auto" title="Clear sticky/cooldown for this entry">❌ Reset timer</button>`
      : '';
    el.innerHTML = `<div class="editor-pane" style="margin-top:8px;border-color:var(--accent)">
      <h4>Entry Editor</h4>
      ${timedStatusHtml}

      <label>Primary Keywords <span style="color:var(--text3)">(comma-separated)</span>
        <input id="eKw" value="${esc((e.keyword || []).join(', '))}">
      </label>
      <label>Content
        <textarea id="eContent" rows="4">${esc(e.content || '')}</textarea>
      </label>

      <div class="section-header">Trigger & Position</div>
      <div class="grid3">
        <label>Trigger Mode
          <select id="eTrigger">
            <option value="keyword" ${tm === 'keyword' ? 'selected' : ''}>🔑 Keyword</option>
            <option value="constant" ${tm === 'constant' ? 'selected' : ''}>🔒 Constant</option>
            <option value="vectorized" ${tm === 'vectorized' ? 'selected' : ''}>🧠 Vectorized</option>
          </select>
        </label>
        <label>Position
          <select id="ePos">
            <option value="before_char" ${pos === 'before_char' ? 'selected' : ''}>↑ Before Char</option>
            <option value="after_char" ${pos === 'after_char' ? 'selected' : ''}>↓ After Char</option>
            <option value="at_depth" ${pos === 'at_depth' ? 'selected' : ''}>📐 At Depth</option>
            <option value="an_top" ${pos === 'an_top' ? 'selected' : ''}>⬆ AN Top</option>
            <option value="an_bottom" ${pos === 'an_bottom' ? 'selected' : ''}>⬇ AN Bottom</option>
          </select>
        </label>
        <label>Order
          <input type="number" id="eOrder" value="${e.order ?? 100}">
        </label>
      </div>
      <div class="grid3">
        <label>Depth <span style="color:var(--text3)">(at_depth)</span>
          <input type="number" id="eDepth" value="${e.depth ?? 4}" min="0">
        </label>
        <label>Scan Depth <span style="color:var(--text3)">(0=global)</span>
          <input type="number" id="eScanDepth" value="${e.scanDepth || 0}" min="0">
        </label>
        <label>Probability %
          <input type="number" id="eProb" value="${e.probability ?? 100}" min="0" max="100">
        </label>
      </div>

      <div class="section-header">Timed Effects</div>
      <div class="timed-desc">All values are in <b>messages</b>. 0 = disabled.</div>
      <div class="grid3">
        <label title="Entry stays active N messages after triggering, even if the keyword leaves the scan buffer">
          📌 Sticky
          <input type="number" id="eSticky" value="${e.sticky || 0}" min="0" placeholder="0">
          <span class="field-hint">msgs active after trigger</span>
        </label>
        <label title="After activation (or sticky expiry), entry cannot trigger again for N messages">
          ⏸ Cooldown
          <input type="number" id="eCooldown" value="${e.cooldown || 0}" min="0" placeholder="0">
          <span class="field-hint">msgs blocked after trigger</span>
        </label>
        <label title="Entry cannot trigger before N total messages have passed in the chat">
          ⏳ Delay
          <input type="number" id="eDelay" value="${e.delay || 0}" min="0" placeholder="0">
          <span class="field-hint">min msgs before first trigger</span>
        </label>
      </div>
      <label>Group
        <input id="eGroup" value="${esc(e.group || '')}" placeholder="Optional grouping tag">
      </label>

      <div class="section-header">Flags</div>
      <div class="flags-row">
        <label class="inline"><input type="checkbox" id="eEnabled" ${e.enabled ? 'checked' : ''}> Enabled</label>
        <label class="inline"><input type="checkbox" id="eUseProb" ${e.useProbability ? 'checked' : ''}> Use Prob.</label>
        <label class="inline"><input type="checkbox" id="eExcRec" ${e.excludeRecursion ? 'checked' : ''}> No Recursion</label>
      </div>

      <div class="section-header">Selective Keywords</div>
      <label class="inline"><input type="checkbox" id="eSelective" ${e.selective ? 'checked' : ''}> Enable selective (secondary keywords)</label>
      <div id="eSecWrap" style="display:${e.selective ? 'block' : 'none'};margin-top:6px">
        <label>Secondary Keywords
          <input id="eKw2" value="${esc((e.keysecondary || []).join(', '))}">
        </label>
        <label>Logic
          <select id="eSelLogic">
            <option value="0" ${sl === 0 ? 'selected' : ''}>AND — all must match</option>
            <option value="1" ${sl === 1 ? 'selected' : ''}>NOT ANY — none must match</option>
            <option value="2" ${sl === 2 ? 'selected' : ''}>NOT ALL — not all match</option>
          </select>
        </label>
      </div>

      <div class="sep"></div>
      <div class="row">
        <button class="primary" id="btnSaveEntry">💾 Save</button>
        <button id="btnVectorize">🧠 Vectorize</button>
        <button class="sm" id="btnCloseEntry">Close</button>
        ${resetTimedBtnHtml}
        <button class="sm danger" id="btnDeleteEntry">🗑</button>
      </div>
      <div id="vecStatus" style="font-size:11px;color:var(--text2);margin-top:4px">
        ${getEntryEmbeddings(e) ? '✅ Embedded (' + (e.embeddings ? e.embeddings.length + ' chunks × ' + e.embeddings[0].length + 'd' : e.embedding.length + 'd (legacy)') + ')' : '⚠️ No embedding — click 🧠 Vectorize to compute multi-chunk embeddings'}
      </div>
    </div>`;

    // Wire events
    $('#eSelective').addEventListener('change', () => {
      $('#eSecWrap').style.display = $('#eSelective').checked ? 'block' : 'none';
    });

    $('#btnSaveEntry').addEventListener('click', () => {
      const entry = book.entries.find(x => x.id === e.id);
      if (!entry) return;
      entry.keyword = $('#eKw').value.split(',').map(s => s.trim()).filter(Boolean);
      entry.content = $('#eContent').value;
      entry.triggerMode = $('#eTrigger').value;
      entry.constant = entry.triggerMode === 'constant';
      entry.position = $('#ePos').value;
      entry.order = parseInt($('#eOrder').value) || 100;
      entry.depth = parseInt($('#eDepth').value) || 4;
      entry.scanDepth = parseInt($('#eScanDepth').value) || null;
      entry.probability = parseInt($('#eProb').value) || 100;
      entry.sticky = parseInt($('#eSticky').value) || 0;
      entry.cooldown = parseInt($('#eCooldown').value) || 0;
      entry.delay = parseInt($('#eDelay').value) || 0;
      entry.group = $('#eGroup').value.trim();
      entry.enabled = $('#eEnabled').checked;
      entry.useProbability = $('#eUseProb').checked;
      entry.excludeRecursion = $('#eExcRec').checked;
      entry.selective = $('#eSelective').checked;
      if (entry.selective) {
        entry.keysecondary = $('#eKw2').value.split(',').map(s => s.trim()).filter(Boolean);
        entry.selectiveLogic = parseInt($('#eSelLogic').value) || 0;
      }
      storageSet({ loreBooks: D.loreBooks }).then(() => {
        toast('✅ Entry saved');
        renderEntries(book);
        showEntryEditor(book, entry);
      });
    });

    $('#btnCloseEntry').addEventListener('click', () => {
      entryEditorOpen = false; editEntryId = null;
      document.getElementById('entryEditor').innerHTML = '';
    });

    if (document.getElementById('btnResetTimed')) {
      document.getElementById('btnResetTimed').addEventListener('click', () => {
        const newTS = { ...(D.loreTimedState || {}) };
        delete newTS[e.id];
        D.loreTimedState = newTS;
        storageSet({ loreTimedState: newTS }).then(() => {
          toast('❌ Timer reset');
          renderEntries(book);
          showEntryEditor(book, e);
        });
      });
    }

    $('#btnDeleteEntry').addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      book.entries = book.entries.filter(x => x.id !== e.id);
      entryEditorOpen = false; editEntryId = null;
      document.getElementById('entryEditor').innerHTML = '';
      storageSet({ loreBooks: D.loreBooks }).then(() => { toast('Entry deleted'); renderEntries(book); });
    });

    $('#btnVectorize').addEventListener('click', async () => {
      $('#vecStatus').textContent = '⏳ Computing multi-chunk embeddings…';
      const entry = book.entries.find(x => x.id === e.id) || e;
      const ok = await vectorizeEntry(entry);
      if (ok) {
        entry.triggerMode = 'vectorized';
        await storageSet({ loreBooks: D.loreBooks });
        toast(`✅ Embedded (${entry.embeddings.length} chunks × ${entry.embeddings[0].length}d)`);
        renderEntries(book);
        showEntryEditor(book, entry);
      } else {
        $('#vecStatus').textContent = '❌ Embedding computation failed';
        toast('❌ Vectorize failed');
      }
    });
  }

  /* ST Import */
  $('#btnImportST').addEventListener('click', () => $('#fileST').click());
  $('#fileST').addEventListener('change', async ev => {
    const f = ev.target.files[0]; if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      chrome.runtime.sendMessage({ type: 'IMPORT_ST_LOREBOOK', data: json }, r => {
        toast(r?.ok ? `✅ Imported "${r.bookName}" (${r.count} entries)` : `❌ ${r?.error}`);
        load();
      });
    } catch (err) { toast('❌ ' + err.message); }
    ev.target.value = '';
  });

  /* New book */
  $('#btnNewBook').addEventListener('click', () => {
    const b = { id: uid(), name: 'New Lorebook', enabled: true, entries: [] };
    D.loreBooks.push(b);
    storageSet({ loreBooks: D.loreBooks }).then(() => { editBookId = b.id; load(); showBookDetail(b); });
  });

  /* WREC */
  $('#btnWrec').addEventListener('click', () => {
    if (!confirm('Generate lorebook from active card via API?')) return;
    toast('⚡ Generating WREC…');
    chrome.runtime.sendMessage({ type: 'GENERATE_WREC' }, r => {
      toast(r?.ok ? `✅ WREC: ${r.count} entries` : `❌ ${r?.error}`);
      load();
    });
  });

  /* ═══════════════════════════════════════════
     §3 — NOTES
     ═══════════════════════════════════════════ */
  function renderNotes() {
    $('#authorNote').value = D.authorNote || '';
    $('#anDepth').value = D.authorNoteDepth ?? 2;
  }
  // Save author note on blur AND debounced as-you-type (so it's always fresh in content.js cache)
  let anTimer;
  const saveAN = () => {
    const v = $('#authorNote').value;
    storageSet({ authorNote: v });
  };
  $('#authorNote').addEventListener('input', () => { clearTimeout(anTimer); anTimer = setTimeout(saveAN, 600); });
  $('#authorNote').addEventListener('change', () => { clearTimeout(anTimer); saveAN(); toast('Author\'s note saved'); });
  $('#anDepth').addEventListener('change', () => storageSet({ authorNoteDepth: parseInt($('#anDepth').value) || 2 }));

  /* ═══════════════════════════════════════════
     §4 — SETTINGS
     ═══════════════════════════════════════════ */
  function renderSettings() {
    $('#apiKey').value = D.apiKey || '';
    $('#memInterval').value = D.memorySummaryInterval || 10;
    $('#cfgScanDepth').value = D.loreScanDepth ?? 4;
    $('#cfgTokenBudget').value = D.loreTokenBudget ?? 2048;
    $('#cfgRecDepth').value = D.loreRecursionDepth ?? 3;
    $('#cfgVecThresh').value = D.loreVectorThreshold ?? 0.45;
    $('#cfgRecursion').checked = D.loreRecursion !== false;
    $('#cfgVecModel').value = D.loreVectorModel || '';
    $('#cfgLanguage').value = D.loreLanguage || 'English';
    const sel = $('select#cfgDefaultMode');
    if (sel) sel.value = D.loreDefaultTriggerMode || 'keyword';
  }
  $('#btnSaveSettings').addEventListener('click', () => {
    storageSet({
      apiKey: $('#apiKey').value.trim(),
      memorySummaryInterval: parseInt($('#memInterval').value) || 10,
      loreScanDepth: parseInt($('#cfgScanDepth').value) || 4,
      loreTokenBudget: parseInt($('#cfgTokenBudget').value) || 2048,
      loreRecursionDepth: parseInt($('#cfgRecDepth').value) || 3,
      loreVectorThreshold: parseFloat($('#cfgVecThresh').value) || 0.45,
      loreRecursion: $('#cfgRecursion').checked,
      loreVectorModel: $('#cfgVecModel').value.trim(),
      loreLanguage: $('#cfgLanguage').value.trim() || 'English',
      loreDefaultTriggerMode: $('select#cfgDefaultMode')?.value || 'keyword'
    }).then(() => { toast('✅ Settings saved'); load(); });
  });

  /* Factory Reset */
  $('#btnFactoryReset')?.addEventListener('click', async () => {
    if (!confirm('⚠️ This will DELETE all characters, lorebooks, history, settings and API key. Continue?')) return;
    if (!confirm('Are you SURE? This cannot be undone.')) return;
    await chrome.storage.local.clear();
    toast('🗑 All data wiped — reloading…');
    setTimeout(() => load(), 300);
  });

  /* ═══════════════════════════════════════════
     §5 — NOTEBOOK
     ═══════════════════════════════════════════ */
  function renderNotebook() { $('#notebookText').value = D.notebookText || ''; }
  let nbT;
  $('#notebookText').addEventListener('input', () => {
    clearTimeout(nbT);
    nbT = setTimeout(() => storageSet({ notebookText: $('#notebookText').value }), 800);
  });

  /* ═══════════════════════════════════════════
     §6 — INSPECTOR
     ═══════════════════════════════════════════ */
  function renderInspector() {
    const t = D.lastAssembledPrompt || '(no prompt yet)';
    $('#lastPrompt').textContent = t;
    $('#promptTokens').textContent = `~${estimateTokens(t)} tokens`;
  }
  $('#btnRefreshPrompt').addEventListener('click', async () => {
    const d = await storageGet(['lastAssembledPrompt']);
    D.lastAssembledPrompt = d.lastAssembledPrompt;
    renderInspector();
    toast('Refreshed');
  });

  /* ═════════════════════════════════════════════
     VECTOR TESTER
     ═════════════════════════════════════════════ */
  function cosineSim(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
  }

  $('#btnVecTest').addEventListener('click', () => {
    const query = $('#vecTestInput').value.trim();
    if (!query) { toast('Enter a query first'); return; }
    const res = $('#vecTestResults');
    res.innerHTML = '<div style="color:var(--text2);font-size:12px">⏳ Computing embedding…</div>';

    chrome.runtime.sendMessage({ type: 'COMPUTE_EMBEDDING', text: query }, r => {
      if (!r?.ok) { res.innerHTML = `<div style="color:var(--red)">❌ ${esc(r?.error || 'failed')}</div>`; return; }
      const qEmb = r.embedding;
      const thresh = D.loreVectorThreshold || 0.45;

      const all = (D.loreBooks || []).flatMap(b =>
        (b.entries || []).filter(e => getEntryEmbeddings(e)).map(e => ({ ...e, _book: b.name }))
      );

      if (!all.length) {
        res.innerHTML = '<div style="color:var(--text2);font-size:12px">⚠️ No entries with embeddings found.<br>Open a Lorebook entry and click 🧠 Vectorize first.</div>';
        return;
      }

      const scored = all
        .map(e => ({ ...e, score: maxCosineSim(qEmb, getEntryEmbeddings(e)) }))
        .sort((a, b) => b.score - a.score);

      const matchCount = scored.filter(e => e.score >= thresh).length;
      const rows = scored.map(e => {
        const pct = Math.round(e.score * 100);
        const above = e.score >= thresh;
        const col = above ? 'var(--green)' : e.score >= thresh * 0.75 ? 'var(--orange)' : 'var(--red)';
        return `<div style="padding:7px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:3px">
            <span style="font-size:12px;font-weight:700;color:${col};min-width:36px;font-variant-numeric:tabular-nums">${pct}%</span>
            <div style="flex:1;background:var(--surface);border-radius:3px;height:5px;overflow:hidden">
              <div style="height:100%;width:${Math.min(100, pct)}%;background:${col};border-radius:3px"></div>
            </div>
            <span style="font-size:10px;color:${col};font-weight:600">${above ? '✓ MATCH' : '✗'}</span>
          </div>
          <div style="font-size:11px;color:var(--text2)">
            <b style="color:var(--text)">${esc((e.keyword || []).join(', ') || '(no keywords)')}</b>
            <span style="color:var(--text3)"> · ${esc(e._book)}</span><br>
            <span>${esc((e.content || '').substring(0, 100))}${(e.content || '').length > 100 ? '…' : ''}</span>
          </div>
        </div>`;
      }).join('');

      res.innerHTML = `
        <div style="font-size:11px;color:var(--text2);margin-bottom:6px;display:flex;justify-content:space-between">
          <span>Threshold: <b style="color:var(--text)">${thresh}</b></span>
          <span><b style="color:${matchCount ? 'var(--green)' : 'var(--red)'};">${matchCount}</b>/${scored.length} match</span>
        </div>
        ${rows}`;
    });
  });

  // Allow pressing Enter in the test input
  $('#vecTestInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnVecTest').click(); });

  /* ═══════════════════════════════════════════
     §7 — HISTORY
     ═══════════════════════════════════════════ */
  function renderHistory() {
    const hist = D.chatHistory || [];
    $('#histCount').textContent = `${hist.length} messages`;
    const el = $('#historyList');
    el.innerHTML = '';
    if (!hist.length) { el.innerHTML = '<div class="empty"><div class="emoji">💬</div>No messages captured yet.</div>'; return; }
    hist.slice(-50).reverse().forEach(m => {
      const div = document.createElement('div');
      div.className = 'hist-item ' + m.role;
      const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '';
      div.innerHTML = `<span class="hist-time">${time}</span><div class="hist-role">${m.role === 'user' ? '👤 User' : '🤖 Model'}</div><div class="hist-text">${esc((m.text || '').substring(0, 200))}</div>`;
      el.appendChild(div);
    });
  }
  $('#btnClearHistory').addEventListener('click', () => {
    if (!confirm('Clear all captured history?')) return;
    storageSet({ chatHistory: [] }).then(() => { toast('History cleared'); load(); });
  });

  /* ═══════════════════════════════════════════
     §8 — TOKENS
     ═══════════════════════════════════════════ */
  function renderTokens() {
    const card = (D.characterCards || []).find(c => c.id === D.activeCard);
    const cardTok = card ? estimateTokens([card.systemPrompt, card.description, card.personality, card.scenario].filter(Boolean).join(' ')) : 0;
    const loreTok = (D.loreBooks || []).filter(b => b.enabled).flatMap(b => b.entries || []).filter(e => e.enabled).reduce((s, e) => s + estimateTokens(e.content), 0);
    const anTok = estimateTokens(D.authorNote || '');
    const histTok = (D.chatHistory || []).reduce((s, m) => s + estimateTokens(m.text), 0);
    const total = cardTok + loreTok + anTok;
    const budget = D.loreTokenBudget || 2048;
    const pct = Math.min(100, (loreTok / budget) * 100);

    $('#tokenInfo').innerHTML = `
      <div class="tok-row"><span class="tok-label">🎭 Character Card</span><span class="tok-value">${cardTok}</span></div>
      <div class="tok-row"><span class="tok-label">📚 Lorebook (enabled)</span><span class="tok-value">${loreTok}</span></div>
      <div class="tok-row"><span class="tok-label">✍️ Author's Note</span><span class="tok-value">${anTok}</span></div>
      <div class="tok-row"><span class="tok-label">💬 Chat History</span><span class="tok-value">${histTok}</span></div>
      <div class="sep" style="margin:6px 0"></div>
      <div class="tok-row"><span class="tok-label"><b>Context Total</b></span><span class="tok-value" style="color:var(--accent)">${total}</span></div>
      <div style="margin-top:8px">
        <div class="tok-row"><span class="tok-label">Lore Budget</span><span class="tok-value">${loreTok}/${budget}</span></div>
        <div class="tok-bar-wrap"><div class="tok-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  }

  /* ═══════ LIVE RELOAD ═══════ */
  chrome.storage.onChanged.addListener(() => load());

  /* ═══════ INIT ═══════ */
  load();
})();
