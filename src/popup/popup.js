/**
 * popup.js — Compact popup UI  (v3)
 *
 * Tabs: Cards | Lore | Notes | Settings
 * Full lorebook editor with ALL SillyTavern fields
 */

(function () {
  'use strict';

  /* ── Globals ── */
  let DATA = {};
  let editingCardId = null;
  let editingBookId = null;
  let editingEntryId = null;

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  /* ══════════ TABS ══════════ */
  $$('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tabs button').forEach(b => b.classList.remove('active'));
      $$('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`#panel-${btn.dataset.tab}`).classList.add('active');
    });
  });

  /* ══════════ LOAD DATA ══════════ */
  async function load() {
    DATA = await storageGetAll();
    renderMemCounter();
    renderCards();
    renderBooks();
    renderNotes();
    renderSettings();
  }

  /* ══════════ MEMORY COUNTER ══════════ */
  function renderMemCounter() {
    $('#memCurrent').textContent = DATA.repliesSinceLastSummary || 0;
    $('#memTotal').textContent = DATA.memorySummaryInterval || 10;
  }

  $('#btnResetConvo').addEventListener('click', () => {
    if (!confirm('Reset conversation? This clears chat history and timed state.')) return;
    chrome.runtime.sendMessage({ type: 'RESET_CONVERSATION' }, () => load());
  });

  $('#btnForceMem').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'SUMMARIZE_MEMORY' }, r => {
      alert(r?.ok ? `Created ${r.bookName} (${r.count} entries)` : `Error: ${r?.error}`);
      load();
    });
  });

  /* ══════════ CARDS ══════════ */
  function renderCards() {
    const el = $('#cardsList');
    el.innerHTML = '';
    (DATA.characterCards || []).forEach(c => {
      const div = document.createElement('div');
      const isActive = c.id === DATA.activeCard;
      div.className = 'card-item' + (isActive ? ' active-card' : '');
      div.innerHTML = `<b>${esc(c.name || 'Unnamed')}</b>` +
        (isActive ? ' <span class="badge green">active</span>' : '') +
        ` <button class="sm" style="float:right;margin-left:4px">${isActive ? '✕' : '✓'}</button>` +
        ` <button class="sm card-edit" style="float:right">✏</button>`;
      div.querySelector('.sm:not(.card-edit)').addEventListener('click', (e) => {
        e.stopPropagation();
        DATA.activeCard = isActive ? null : c.id;
        storageSet({ activeCard: DATA.activeCard }).then(() => load());
      });
      div.querySelector('.card-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        editingCardId = c.id;
        showCardEditor(c);
      });
      el.appendChild(div);
    });
  }

  function showCardEditor(c) {
    $('#cardEditor').style.display = 'block';
    $('#cName').value = c.name || '';
    $('#cSystem').value = c.systemPrompt || '';
    $('#cDesc').value = c.description || '';
    $('#cPersonality').value = c.personality || '';
    $('#cScenario').value = c.scenario || '';
    $('#cFirstMsg').value = c.firstMessage || '';
  }

  $('#btnNewCard').addEventListener('click', () => {
    const c = { id: uid(), name: 'New Card', systemPrompt: '', description: '', personality: '', scenario: '', firstMessage: '' };
    DATA.characterCards.push(c);
    storageSet({ characterCards: DATA.characterCards }).then(() => { editingCardId = c.id; load(); showCardEditor(c); });
  });

  $('#btnSaveCard').addEventListener('click', () => {
    if (!editingCardId) return;
    const c = DATA.characterCards.find(x => x.id === editingCardId);
    if (!c) return;
    c.name = $('#cName').value; c.systemPrompt = $('#cSystem').value; c.description = $('#cDesc').value;
    c.personality = $('#cPersonality').value; c.scenario = $('#cScenario').value; c.firstMessage = $('#cFirstMsg').value;
    storageSet({ characterCards: DATA.characterCards }).then(() => renderCards());
  });

  $('#btnDeleteCard').addEventListener('click', () => {
    if (!editingCardId || !confirm('Delete this card?')) return;
    DATA.characterCards = DATA.characterCards.filter(c => c.id !== editingCardId);
    if (DATA.activeCard === editingCardId) DATA.activeCard = null;
    editingCardId = null;
    $('#cardEditor').style.display = 'none';
    storageSet({ characterCards: DATA.characterCards, activeCard: DATA.activeCard }).then(() => load());
  });

  $('#btnImportCard').addEventListener('click', () => $('#fileCard').click());
  $('#fileCard').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const text = await f.text();
      const json = JSON.parse(text);
      const spec = json.data || json;
      const c = {
        id: uid(), name: spec.name || f.name,
        systemPrompt: spec.system_prompt || spec.systemPrompt || '',
        description: spec.description || '', personality: spec.personality || '',
        scenario: spec.scenario || '', firstMessage: spec.first_mes || spec.firstMessage || ''
      };
      DATA.characterCards.push(c);
      DATA.activeCard = c.id;
      await storageSet({ characterCards: DATA.characterCards, activeCard: c.id });
      load();
    } catch (err) { alert('Import error: ' + err.message); }
    e.target.value = '';
  });

  /* ══════════ LOREBOOKS ══════════ */
  function renderBooks() {
    const el = $('#booksList');
    el.innerHTML = '';
    (DATA.loreBooks || []).forEach(b => {
      const div = document.createElement('div');
      div.className = 'book-item';
      div.innerHTML = `<b>${esc(b.name)}</b> <span class="badge ${b.enabled ? 'green' : ''}">${b.entries?.length || 0} entries</span>`;
      div.addEventListener('click', () => { editingBookId = b.id; editingEntryId = null; showBookEditor(b); });
      el.appendChild(div);
    });
  }

  function showBookEditor(b) {
    $('#bookEditor').style.display = 'block';
    $('#bName').value = b.name;
    $('#bEnabled').checked = b.enabled;
    renderEntries(b);
  }

  function renderEntries(book) {
    const el = $('#entriesList');
    el.innerHTML = '';
    (book.entries || []).forEach(e => {
      const div = document.createElement('div');
      div.className = 'entry-item';
      const kw = (e.keyword || []).join(', ');
      div.innerHTML = `<b>${esc(kw || '(no keywords)')}</b> — ${esc((e.content || '').substring(0, 60))}`;
      div.addEventListener('click', () => { editingEntryId = e.id; showEntryEditor(e); });
      el.appendChild(div);
    });
  }

  $('#btnNewBook').addEventListener('click', () => {
    const b = { id: uid(), name: 'New Lorebook', enabled: true, entries: [] };
    DATA.loreBooks.push(b);
    storageSet({ loreBooks: DATA.loreBooks }).then(() => { editingBookId = b.id; load(); showBookEditor(b); });
  });

  $('#btnDeleteBook').addEventListener('click', () => {
    if (!editingBookId || !confirm('Delete this book?')) return;
    DATA.loreBooks = DATA.loreBooks.filter(b => b.id !== editingBookId);
    editingBookId = null;
    $('#bookEditor').style.display = 'none';
    $('#entryEditor').style.display = 'none';
    storageSet({ loreBooks: DATA.loreBooks }).then(() => load());
  });

  $('#bName').addEventListener('change', () => {
    const b = DATA.loreBooks.find(x => x.id === editingBookId);
    if (b) { b.name = $('#bName').value; storageSet({ loreBooks: DATA.loreBooks }); }
  });
  $('#bEnabled').addEventListener('change', () => {
    const b = DATA.loreBooks.find(x => x.id === editingBookId);
    if (b) { b.enabled = $('#bEnabled').checked; storageSet({ loreBooks: DATA.loreBooks }); }
  });

  $('#btnNewEntry').addEventListener('click', () => {
    const b = DATA.loreBooks.find(x => x.id === editingBookId);
    if (!b) return;
    const e = createLoreEntry();
    b.entries.push(e);
    storageSet({ loreBooks: DATA.loreBooks }).then(() => { renderEntries(b); editingEntryId = e.id; showEntryEditor(e); });
  });

  /* ── SillyTavern Import ── */
  $('#btnImportST').addEventListener('click', () => $('#fileST').click());
  $('#fileST').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const json = JSON.parse(await f.text());
      chrome.runtime.sendMessage({ type: 'IMPORT_ST_LOREBOOK', data: json }, r => {
        alert(r?.ok ? `Imported "${r.bookName}" (${r.count} entries)` : `Error: ${r?.error}`);
        load();
      });
    } catch (err) { alert('Import error: ' + err.message); }
    e.target.value = '';
  });

  /* ── WREC ── */
  $('#btnWrec').addEventListener('click', () => {
    if (!confirm('Generate lorebook from active card? (uses API)')) return;
    chrome.runtime.sendMessage({ type: 'GENERATE_WREC' }, r => {
      alert(r?.ok ? `WREC: ${r.count} entries generated` : `Error: ${r?.error}`);
      load();
    });
  });

  /* ══════════ ENTRY EDITOR (Full ST fields) ══════════ */
  function showEntryEditor(e) {
    const el = $('#entryEditor');
    el.style.display = 'block';
    el.innerHTML = buildEntryEditorHTML(e);
    attachEntryEditorEvents(e);
  }

  function buildEntryEditorHTML(e) {
    const pos = e.position || 'after_char';
    const tm = e.triggerMode || 'keyword';
    const sl = e.selectiveLogic ?? 0;
    return `<div class="entry-editor">
      <label>Primary Keywords (comma-sep)<input id="eKw" value="${esc((e.keyword||[]).join(', '))}"></label>
      <label>Content<textarea id="eContent" rows="3">${esc(e.content||'')}</textarea></label>

      <div class="inline-grid">
        <label>Trigger Mode<select id="eTrigger">
          <option value="keyword" ${tm==='keyword'?'selected':''}>Keyword</option>
          <option value="constant" ${tm==='constant'?'selected':''}>Constant</option>
          <option value="vectorized" ${tm==='vectorized'?'selected':''}>Vectorized</option>
        </select></label>
        <label>Position<select id="ePos">
          <option value="before_char" ${pos==='before_char'?'selected':''}>Before Char</option>
          <option value="after_char" ${pos==='after_char'?'selected':''}>After Char</option>
          <option value="at_depth" ${pos==='at_depth'?'selected':''}>At Depth</option>
          <option value="an_top" ${pos==='an_top'?'selected':''}>AN Top</option>
          <option value="an_bottom" ${pos==='an_bottom'?'selected':''}>AN Bottom</option>
        </select></label>
      </div>

      <div class="inline-grid">
        <label>Order<input type="number" id="eOrder" value="${e.order??100}"></label>
        <label>Depth<input type="number" id="eDepth" value="${e.depth??4}" min="0"></label>
        <label>Scan Depth (0=global)<input type="number" id="eScanDepth" value="${e.scanDepth||0}" min="0"></label>
        <label>Probability %<input type="number" id="eProb" value="${e.probability??100}" min="0" max="100"></label>
      </div>

      <div class="inline-grid">
        <label>Sticky (msgs)<input type="number" id="eSticky" value="${e.sticky||0}" min="0"></label>
        <label>Cooldown (msgs)<input type="number" id="eCooldown" value="${e.cooldown||0}" min="0"></label>
        <label>Delay (msgs)<input type="number" id="eDelay" value="${e.delay||0}" min="0"></label>
        <label>Group<input id="eGroup" value="${esc(e.group||'')}"></label>
      </div>

      <label><input type="checkbox" id="eEnabled" ${e.enabled?'checked':''}> Enabled</label>
      <label><input type="checkbox" id="eSelective" ${e.selective?'checked':''}> Selective (secondary kw)</label>
      <div id="eSecondaryWrap" style="display:${e.selective?'block':'none'}">
        <label>Secondary Keywords<input id="eKw2" value="${esc((e.keysecondary||[]).join(', '))}"></label>
        <label>Logic<select id="eSelLogic">
          <option value="0" ${sl===0?'selected':''}>AND all</option>
          <option value="1" ${sl===1?'selected':''}>NOT ANY</option>
          <option value="2" ${sl===2?'selected':''}>NOT ALL</option>
        </select></label>
      </div>
      <label><input type="checkbox" id="eUseProb" ${e.useProbability?'checked':''}> Use Probability</label>
      <label><input type="checkbox" id="eExcRec" ${e.excludeRecursion?'checked':''}> Exclude from Recursion</label>

      <div class="row" style="margin-top:6px">
        <button id="btnSaveEntry">💾 Save Entry</button>
        <button id="btnVectorize">🧠 Vectorize</button>
        <button id="btnDeleteEntry" class="danger">🗑 Delete</button>
      </div>
      ${e.embedding ? '<p class="small">✅ Has embedding (' + e.embedding.length + 'd)</p>' : '<p class="small">No embedding</p>'}
    </div>`;
  }

  function attachEntryEditorEvents(e) {
    $('#eSelective').addEventListener('change', () => {
      $('#eSecondaryWrap').style.display = $('#eSelective').checked ? 'block' : 'none';
    });

    $('#btnSaveEntry').addEventListener('click', () => {
      const b = DATA.loreBooks.find(x => x.id === editingBookId);
      if (!b) return;
      const entry = b.entries.find(x => x.id === e.id);
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
      entry.selective = $('#eSelective').checked;
      entry.useProbability = $('#eUseProb').checked;
      entry.excludeRecursion = $('#eExcRec').checked;
      if (entry.selective) {
        entry.keysecondary = $('#eKw2').value.split(',').map(s => s.trim()).filter(Boolean);
        entry.selectiveLogic = parseInt($('#eSelLogic').value) || 0;
      }

      storageSet({ loreBooks: DATA.loreBooks }).then(() => { renderEntries(b); showEntryEditor(entry); });
    });

    $('#btnDeleteEntry').addEventListener('click', () => {
      if (!confirm('Delete this entry?')) return;
      const b = DATA.loreBooks.find(x => x.id === editingBookId);
      if (!b) return;
      b.entries = b.entries.filter(x => x.id !== e.id);
      $('#entryEditor').style.display = 'none';
      storageSet({ loreBooks: DATA.loreBooks }).then(() => renderEntries(b));
    });

    $('#btnVectorize').addEventListener('click', () => {
      const text = (e.keyword || []).join(' ') + ' ' + (e.content || '');
      chrome.runtime.sendMessage({ type: 'COMPUTE_EMBEDDING', text }, r => {
        if (r?.ok && r.embedding) {
          const b = DATA.loreBooks.find(x => x.id === editingBookId);
          const entry = b?.entries.find(x => x.id === e.id);
          if (entry) { entry.embedding = r.embedding; entry.triggerMode = 'vectorized'; }
          storageSet({ loreBooks: DATA.loreBooks }).then(() => showEntryEditor(entry || e));
          alert('Embedding computed (' + r.embedding.length + 'd)');
        } else {
          alert('Error: ' + (r?.error || 'unknown'));
        }
      });
    });
  }

  /* ══════════ NOTES ══════════ */
  function renderNotes() {
    $('#authorNote').value = DATA.authorNote || '';
    $('#anDepth').value = DATA.authorNoteDepth ?? 2;
  }

  $('#authorNote').addEventListener('change', () => storageSet({ authorNote: $('#authorNote').value }));
  $('#anDepth').addEventListener('change', () => storageSet({ authorNoteDepth: parseInt($('#anDepth').value) || 2 }));

  /* ══════════ SETTINGS ══════════ */
  function renderSettings() {
    $('#apiKey').value = DATA.apiKey || '';
    $('#memInterval').value = DATA.memorySummaryInterval || 10;
    $('#cfgScanDepth').value = DATA.loreScanDepth ?? 4;
    $('#cfgTokenBudget').value = DATA.loreTokenBudget ?? 2048;
    $('#cfgRecDepth').value = DATA.loreRecursionDepth ?? 3;
    $('#cfgVecThresh').value = DATA.loreVectorThreshold ?? 0.45;
    $('#cfgRecursion').checked = DATA.loreRecursion !== false;
    $('#cfgVecModel').value = DATA.loreVectorModel || 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
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
      loreVectorModel: $('#cfgVecModel').value.trim()
    }).then(() => { alert('Settings saved'); load(); });
  });

  /* ══════════ UTILS ══════════ */
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  /* ══════════ STORAGE CHANGE ══════════ */
  chrome.storage.onChanged.addListener(() => load());

  /* ══════════ INIT ══════════ */
  load();
})();
