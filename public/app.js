/* Folio — front-end for the Transaction Ledger API (vanilla JS, no build step) */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    accounts: [],
    selectedId: localStorage.getItem('folio.selected') || null,
    filter: 'all', // all | credit | debit
    page: 1,
    limit: 10,
    tx: null, // { data, pagination }
    verify: null,
    loadingTx: false,
  };

  // ── formatting ──────────────────────────────────────────────────────────
  const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
  const fmt = (n) => money.format(n);
  const fmtDate = (iso) => {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
    return `${day}<small>${time}</small>`;
  };
  const ACCENTS = ['#1f2a5a', '#cf3a22', '#1f7a55', '#5a4bb3', '#b7791f', '#0e7490', '#9d174d'];
  const accentFor = (id) => {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return ACCENTS[h % ACCENTS.length];
  };
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── API ─────────────────────────────────────────────────────────────────
  class ApiError extends Error {
    constructor(status, payload) {
      super((payload && payload.error && payload.error.message) || `Request failed (${status})`);
      this.status = status;
      this.code = payload && payload.error && payload.error.code;
      this.details = payload && payload.error && payload.error.details;
    }
  }

  async function api(method, path, body) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the server. Is it running?' } });
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, payload);
    return payload;
  }

  // ── stamps (notifications) ──────────────────────────────────────────────
  const STAMP_TITLES = {
    DUPLICATE_TRANSACTION: 'Duplicate',
    INSUFFICIENT_BALANCE: 'Insufficient funds',
    VALIDATION_ERROR: 'Check the form',
    ACCOUNT_NOT_FOUND: 'Not found',
    NETWORK: 'Offline',
  };
  function stamp(kind, title, message, ms = 4200) {
    const el = document.createElement('div');
    el.className = `stamp ${kind}`;
    el.innerHTML = `<b>${esc(title)}</b>${message ? `<span>${esc(message)}</span>` : ''}`;
    $('#stamps').appendChild(el);
    const kill = () => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    };
    el.addEventListener('click', kill);
    setTimeout(kill, ms);
  }
  const stampError = (err) =>
    stamp(err.code === 'DUPLICATE_TRANSACTION' ? 'warn' : 'err', STAMP_TITLES[err.code] || 'Rejected', err.message);

  // ── data loading ────────────────────────────────────────────────────────
  async function loadAccounts() {
    const res = await api('GET', '/accounts?limit=100');
    state.accounts = res.data;
    if (!state.accounts.find((a) => a.id === state.selectedId)) {
      state.selectedId = state.accounts[0] ? state.accounts[0].id : null;
    }
    renderIndex();
  }

  async function loadTransactions({ keepScroll = true } = {}) {
    if (!state.selectedId) return;
    state.loadingTx = true;
    const params = new URLSearchParams({ page: state.page, limit: state.limit });
    if (state.filter !== 'all') params.set('type', state.filter);
    try {
      const [tx, verify] = await Promise.all([
        api('GET', `/accounts/${state.selectedId}/transactions?${params}`),
        api('GET', `/accounts/${state.selectedId}/verify`),
      ]);
      // If the current page vanished (shouldn't happen, but be safe), fall back to the last page.
      if (tx.data.length === 0 && tx.pagination.total_records > 0 && state.page > 1) {
        state.page = Math.max(1, tx.pagination.total_pages);
        return loadTransactions({ keepScroll });
      }
      state.tx = tx;
      state.verify = verify;
    } catch (err) {
      stampError(err);
    } finally {
      state.loadingTx = false;
    }
    renderFolio();
  }

  async function select(id) {
    state.selectedId = id;
    localStorage.setItem('folio.selected', id);
    state.page = 1;
    state.filter = 'all';
    state.tx = null;
    renderIndex();
    renderFolio();
    await loadTransactions();
  }

  // ── rendering: index ────────────────────────────────────────────────────
  function renderIndex() {
    $('#accountCount').textContent = state.accounts.length;
    const list = $('#accountList');
    if (!state.accounts.length) {
      list.innerHTML = `<li class="empty-tabs">No accounts yet.<br/>Open your first one above.</li>`;
      return;
    }
    list.innerHTML = state.accounts
      .map(
        (a) => `
        <li>
          <button class="tab" role="tab" data-id="${esc(a.id)}" aria-selected="${a.id === state.selectedId}"
                  style="--accent:${accentFor(a.id)}">
            <span class="tab-name">${esc(a.name)}</span>
            <span class="tab-bal">${fmt(a.balance)}</span>
            <span class="tab-meta">Opened ${new Date(a.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
          </button>
        </li>`
      )
      .join('');
  }

  // ── rendering: folio ────────────────────────────────────────────────────
  const checkIcon = `<svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 10.4l2.5 2.5L14 7.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const warnIcon = `<svg width="16" height="16" viewBox="0 0 20 20"><path d="M10 2l9 16H1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 8v4M10 14.5v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

  function renderFolio() {
    const folio = $('#folio');
    const account = state.accounts.find((a) => a.id === state.selectedId);

    if (!account) {
      folio.innerHTML = `
        <div class="folio-empty"><div>
          <div class="seal">F</div>
          <h3>A fresh ledger</h3>
          <p>Open an account from the index on the left, then post credits, debits and transfers. Every entry is permanent — just like ink.</p>
        </div></div>`;
      return;
    }

    const v = state.verify;
    const verifyHtml = v
      ? v.consistent
        ? `<div class="verify">${checkIcon} Books balanced · ${v.transaction_count} entries</div>`
        : `<div class="verify bad">${warnIcon} Mismatch · computed ${fmt(v.computed_balance)}</div>`
      : `<div class="verify" style="opacity:.5">Checking books…</div>`;

    folio.innerHTML = `
      <div class="folio-head">
        <div>
          <p class="eyebrow">Account folio</p>
          <h2 class="acct-name">${esc(account.name)}</h2>
          <p class="acct-sub">ID <button type="button" id="copyId" title="Copy account id">${esc(account.id)}</button></p>
        </div>
        <div class="balance-card">
          <div class="label">Current balance</div>
          <div class="value" id="balanceValue">${fmt(account.balance)}</div>
          ${verifyHtml}
        </div>
      </div>

      <div class="actions">
        <button class="btn btn-credit" data-open="credit">＋ Credit</button>
        <button class="btn btn-debit" data-open="debit">－ Debit</button>
        <button class="btn btn-transfer" data-open="transfer" ${state.accounts.length < 2 ? 'disabled title="Open a second account to transfer"' : ''}>⇄ Transfer</button>
      </div>

      <div class="toolbar">
        <div class="filters" role="group" aria-label="Filter entries">
          ${[['all', 'All entries'], ['credit', 'Credits'], ['debit', 'Debits']]
            .map(([k, label]) => `<button data-filter="${k}" aria-pressed="${state.filter === k}">${label}</button>`)
            .join('')}
        </div>
        <label class="page-size">Rows
          <select id="pageSize">${[5, 10, 25, 50]
            .map((n) => `<option value="${n}" ${n === state.limit ? 'selected' : ''}>${n}</option>`)
            .join('')}</select>
        </label>
      </div>

      <div class="sheet"><div class="sheet-scroll">${renderTable()}</div></div>
      ${renderPager()}
    `;
  }

  function renderTable() {
    if (!state.tx) {
      return `<div style="padding:22px">${'<div class="skeleton" style="margin-bottom:16px"></div>'.repeat(5)}</div>`;
    }
    if (!state.tx.data.length) {
      const msg =
        state.filter === 'all'
          ? ['Nothing posted yet', 'Post a credit to put the first line in this ledger.']
          : [`No ${state.filter}s`, 'Try another filter to see the rest of the entries.'];
      return `<div class="sheet-empty"><b>${msg[0]}</b>${msg[1]}</div>`;
    }
    const rows = state.tx.data
      .map((t, i) => {
        const isCredit = t.type === 'credit';
        const cell = (on, cls) =>
          on ? `<td class="num amt ${cls}">${isCredit ? '+' : '−'}${fmt(t.amount)}</td>` : `<td class="num amt"><span class="dash">—</span></td>`;
        return `
        <tr style="animation-delay:${i * 28}ms">
          <td class="date">${fmtDate(t.created_at)}</td>
          <td class="ref" title="${esc(t.reference_id)}">${esc(t.reference_id)}</td>
          <td class="desc"><div class="desc-main" title="${esc(t.description)}">${esc(t.description) || '<span style="color:#b9b09a">—</span>'}${t.transfer_id ? '<span class="chip">transfer</span>' : ''}</div></td>
          ${cell(!isCredit, 'debit')}
          ${cell(isCredit, 'credit')}
          <td class="num bal">${fmt(t.balance_after)}</td>
        </tr>`;
      })
      .join('');
    return `
      <table>
        <thead><tr>
          <th>Date</th><th>Reference</th><th>Description</th>
          <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderPager() {
    if (!state.tx) return '';
    const p = state.tx.pagination;
    const pages = Math.max(1, p.total_pages);
    return `
      <div class="pager">
        <div class="info">Folio <b>${p.current_page}</b> of <b>${pages}</b> · ${p.total_records} ${p.total_records === 1 ? 'entry' : 'entries'}</div>
        <div class="btns">
          <button class="btn btn-ghost" data-page="prev" ${p.current_page <= 1 ? 'disabled' : ''}>← Newer</button>
          <button class="btn btn-ghost" data-page="next" ${p.current_page >= pages ? 'disabled' : ''}>Older →</button>
        </div>
      </div>`;
  }

  // ── events: index & folio (delegated) ───────────────────────────────────
  $('#accountList').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab && tab.dataset.id !== state.selectedId) select(tab.dataset.id);
  });

  $('#newAccountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#newAccountName');
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return stamp('err', 'Name required', 'Give the account holder a name first.');
    }
    try {
      const acc = await api('POST', '/accounts', { name });
      input.value = '';
      await loadAccounts();
      stamp('ok', 'Account opened', `${acc.name} · balance ₹0.00`);
      await select(acc.id);
    } catch (err) {
      stampError(err);
    }
  });

  $('#folio').addEventListener('click', async (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return openVoucher(open.dataset.open);

    const filter = e.target.closest('[data-filter]');
    if (filter) {
      state.filter = filter.dataset.filter;
      state.page = 1;
      return loadTransactions();
    }
    const pager = e.target.closest('[data-page]');
    if (pager && !pager.disabled) {
      state.page += pager.dataset.page === 'next' ? 1 : -1;
      return loadTransactions();
    }
    if (e.target.closest('#copyId')) {
      try {
        await navigator.clipboard.writeText(state.selectedId);
        stamp('ok', 'Copied', 'Account id is on your clipboard.', 1800);
      } catch {
        /* clipboard unavailable */
      }
    }
  });

  $('#folio').addEventListener('change', (e) => {
    if (e.target.id === 'pageSize') {
      state.limit = Number(e.target.value);
      state.page = 1;
      loadTransactions();
    }
  });

  // ── voucher dialog ──────────────────────────────────────────────────────
  const dlg = $('#voucher');
  const vAmount = $('#vAmount');
  const vRef = $('#vRef');
  const vDesc = $('#vDesc');
  const vTo = $('#vTo');
  let mode = 'credit';
  let busy = false;

  const genRef = () => {
    const rnd = Math.random().toString(36).slice(2, 5).toUpperCase();
    return `REF-${Date.now().toString(36).toUpperCase()}-${rnd}`;
  };

  function setMode(next) {
    mode = next;
    for (const b of document.querySelectorAll('#typeSeg button')) b.setAttribute('aria-checked', String(b.dataset.mode === next));
    $('#fieldTo').hidden = next !== 'transfer';
    $('#voucherTitle').textContent = { credit: 'Credit entry', debit: 'Debit entry', transfer: 'Transfer funds' }[next];
    const submit = $('#voucherSubmit');
    submit.textContent = { credit: 'Post credit', debit: 'Post debit', transfer: 'Send transfer' }[next];
    submit.className = `btn btn-${next}`;
    hideFormError();
  }

  function openVoucher(initialMode) {
    const account = state.accounts.find((a) => a.id === state.selectedId);
    if (!account) return;
    $('#voucherEyebrow').textContent = account.name;
    vTo.innerHTML = state.accounts
      .filter((a) => a.id !== account.id)
      .map((a) => `<option value="${esc(a.id)}">${esc(a.name)} — ${fmt(a.balance)}</option>`)
      .join('');
    $('#typeSeg [data-mode="transfer"]').disabled = state.accounts.length < 2;
    vAmount.value = '';
    vDesc.value = '';
    vRef.value = genRef();
    clearInvalid();
    setMode(initialMode);
    if (!dlg.open) dlg.showModal();
    setTimeout(() => vAmount.focus(), 30);
  }

  $('#typeSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) setMode(b.dataset.mode);
  });
  $('#vRefGen').addEventListener('click', () => (vRef.value = genRef()));
  const closeVoucher = () => dlg.close();
  $('#voucherClose').addEventListener('click', closeVoucher);
  $('#voucherCancel').addEventListener('click', closeVoucher);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeVoucher(); // click on backdrop
  });

  function hideFormError() {
    const el = $('#voucherError');
    el.hidden = true;
    el.textContent = '';
  }
  function showFormError(msg) {
    const el = $('#voucherError');
    el.textContent = msg;
    el.hidden = false;
  }
  function clearInvalid() {
    for (const el of dlg.querySelectorAll('.invalid')) el.classList.remove('invalid');
  }
  function markInvalid(el) {
    el.classList.add('invalid');
  }
  const fieldEls = { amount: vAmount, reference_id: vRef, description: vDesc, to_account_id: vTo };

  // Client-side mirror of the server rules (the server stays the source of truth).
  function parseAmount(raw) {
    const cleaned = raw.replace(/[,₹\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
    return Number(cleaned);
  }

  $('#voucherForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    clearInvalid();
    hideFormError();

    const amount = parseAmount(vAmount.value);
    const reference_id = vRef.value.trim();
    const description = vDesc.value.trim();

    if (!(amount > 0)) {
      markInvalid(vAmount.closest('.amount-input'));
      return showFormError('Enter an amount greater than 0 (up to 2 decimal places).');
    }
    if (!reference_id) {
      markInvalid(vRef);
      return showFormError('A reference ID is required — use ↻ Generate if you need one.');
    }
    if (mode === 'transfer' && !vTo.value) {
      markInvalid(vTo);
      return showFormError('Choose the account to send money to.');
    }

    const submit = $('#voucherSubmit');
    busy = true;
    submit.disabled = true;
    const before = state.accounts.find((a) => a.id === state.selectedId);

    try {
      if (mode === 'transfer') {
        const res = await api('POST', '/transfers', {
          from_account_id: state.selectedId,
          to_account_id: vTo.value,
          amount,
          reference_id,
          ...(description && { description }),
        });
        stamp('ok', 'Transfer sent', `${fmt(amount)} → ${res.to_account.name}`);
      } else {
        await api('POST', `/accounts/${state.selectedId}/transactions`, {
          type: mode,
          amount,
          reference_id,
          ...(description && { description }),
        });
        stamp('ok', mode === 'credit' ? 'Credit posted' : 'Debit posted', fmt(amount));
      }
      dlg.close();
      state.page = 1;
      await loadAccounts();
      await loadTransactions();
      const after = state.accounts.find((a) => a.id === state.selectedId);
      if (before && after && before.balance !== after.balance) {
        const el = $('#balanceValue');
        if (el) el.classList.add('bump');
      }
    } catch (err) {
      // Keep the voucher open so the user can fix it; show both inline and as a stamp.
      showFormError(describeError(err));
      if (err.code === 'DUPLICATE_TRANSACTION') markInvalid(vRef);
      if (err.code === 'INSUFFICIENT_BALANCE') markInvalid(vAmount.closest('.amount-input'));
      for (const f of (err.details && err.details.fields) || []) {
        const el = fieldEls[f.field];
        if (el) markInvalid(el.closest('.amount-input') || el);
      }
      stampError(err);
    } finally {
      busy = false;
      submit.disabled = false;
    }
  });

  function describeError(err) {
    if (err.code === 'INSUFFICIENT_BALANCE' && err.details) {
      return `Insufficient balance: available ${fmt(err.details.balance)}, requested ${fmt(err.details.requested)}. Nothing was changed.`;
    }
    if (err.code === 'DUPLICATE_TRANSACTION') {
      return 'This reference ID was already used on this account, so nothing was posted. Generate a new one to continue.';
    }
    if (err.code === 'VALIDATION_ERROR' && err.details && err.details.fields) {
      return err.details.fields.map((f) => f.message).join(' ');
    }
    return err.message;
  }

  // ── health pill ─────────────────────────────────────────────────────────
  async function checkHealth() {
    const pill = $('#healthPill');
    try {
      await api('GET', '/health');
      pill.className = 'pill ok';
      pill.lastElementChild.textContent = 'API online';
    } catch {
      pill.className = 'pill bad';
      pill.lastElementChild.textContent = 'API offline';
    }
  }

  // ── boot ────────────────────────────────────────────────────────────────
  (async function init() {
    renderFolio();
    checkHealth();
    setInterval(checkHealth, 15000);
    try {
      await loadAccounts();
      renderFolio();
      await loadTransactions();
    } catch (err) {
      stampError(err);
    }
  })();
})();
