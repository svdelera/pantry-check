(function () {
  'use strict';

  var AREAS = [
    { id: 'pantry', label: 'Pantry' },
    { id: 'fridge', label: 'Fridge' },
    { id: 'freezer', label: 'Freezer' },
    { id: 'bathroom', label: 'Bathroom' }
  ];
  var LEVELS = ['Out', 'Low', 'OK', 'Full'];
  var UNITS = [
    { id: 'pc', label: 'piece', short: 'pc' },
    { id: 'pack', label: 'pack', short: 'pack' },
    { id: 'kg', label: 'kg', short: 'kg' },
    { id: '100g', label: '100 g', short: '100 g' },
    { id: 'g', label: 'g', short: 'g' },
    { id: 'L', label: 'L', short: 'L' },
    { id: 'ml', label: 'ml', short: 'ml' }
  ];
  var LS_KEY = 'pantry-check-v1';
  var STALE_MS = 14 * 864e5;
  var SAMPLE = {
    pantry: ['Rice', 'Pasta', 'Flour', 'Sugar', 'Salt', 'Cooking oil', 'Olive oil', 'Soy sauce', 'Vinegar', 'Canned tomatoes', 'Canned tuna', 'Instant noodles', 'Oats', 'Coffee', 'Tea', 'Onions', 'Garlic', 'Potatoes'],
    fridge: ['Eggs', 'Milk', 'Butter', 'Cheese', 'Yogurt', 'Carrots', 'Lettuce'],
    freezer: ['Chicken', 'Frozen vegetables', 'Bread', 'Ice cream'],
    bathroom: ['Toothpaste', 'Toothbrush', 'Mouthwash', 'Dental floss', 'Bath soap', 'Shampoo', 'Conditioner', 'Body wash', 'Deodorant', 'Hand sanitizer', 'Lotion', 'Toilet paper', 'Tissues', 'Cotton buds']
  };

  var state = { items: [] };
  var ui = { filter: 'all', view: 'check', removing: null, editing: null, confirmClear: false, confirmAll: false, status: 'loading', copyText: null, cur: '' };
  var dbDoc = null, dl = null, saveTimer = null, saving = false, pendingFlush = false, loadTimer = null;
  var undoSnap = null, toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function now() { return Date.now(); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Math.random().toString(36).slice(2, 8) + now().toString(36).slice(-4); }
  function areaIdx(id) { for (var i = 0; i < AREAS.length; i++) if (AREAS[i].id === id) return i; return 0; }
  function areaLabel(id) { return AREAS[areaIdx(id)].label; }
  function find(id) { for (var i = 0; i < state.items.length; i++) if (state.items[i].id === id) return state.items[i]; return null; }
  function unitOf(id) { for (var i = 0; i < UNITS.length; i++) if (UNITS[i].id === id) return UNITS[i]; return UNITS[0]; }
  function fmt(n) { return n.toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function money(n) { return ui.cur + fmt(n); }

  function clean(it) {
    if (!it || typeof it.name !== 'string' || !it.name.trim()) return null;
    var lvl = Math.round(Number(it.level));
    var price = typeof it.price === 'number' && isFinite(it.price) && it.price >= 0 ? it.price : null;
    var qty = typeof it.qty === 'number' && isFinite(it.qty) && it.qty > 0 ? it.qty : 1;
    return {
      id: typeof it.id === 'string' && it.id ? it.id : uid(),
      name: it.name.trim().slice(0, 80),
      area: AREAS.some(function (a) { return a.id === it.area; }) ? it.area : 'pantry',
      level: lvl >= 0 && lvl <= 3 ? lvl : 3,
      onList: !!it.onList,
      oneOff: !!it.oneOff,
      at: typeof it.at === 'number' ? it.at : 0,
      price: price,
      unit: UNITS.some(function (u) { return u.id === it.unit; }) ? it.unit : 'pc',
      qty: qty
    };
  }

  function ago(t) {
    if (!t) return 'not checked yet';
    var m = Math.floor((now() - t) / 6e4);
    if (m < 2) return 'checked just now';
    if (m < 60) return 'checked ' + m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return 'checked ' + h + ' h ago';
    var d = Math.floor(h / 24);
    if (d < 14) return 'checked ' + d + ' d ago';
    var w = Math.floor(d / 7);
    if (w < 9) return 'checked ' + w + ' wk ago';
    return 'checked ' + Math.floor(d / 30) + ' mo ago';
  }
  function isStale(it) { return !it.at || now() - it.at > STALE_MS; }
  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function priceChip(it) { return it.price == null ? '+ price' : money(it.price) + ' / ' + unitOf(it.unit).short; }
  function qtyText(it) {
    if (it.unit === 'pc') return it.qty === 1 ? '' : '× ' + fmt(it.qty);
    return '× ' + fmt(it.qty) + ' ' + unitOf(it.unit).short;
  }
  function cost(it) { return it.price == null ? null : it.price * it.qty; }

  /* ---------- local copy ---------- */
  function saveLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ items: state.items, cur: ui.cur })); } catch (e) {}
  }
  function loadLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      if (o && Array.isArray(o.items)) state.items = o.items.map(clean).filter(Boolean);
      if (o && typeof o.cur === 'string') ui.cur = o.cur.slice(0, 4);
    } catch (e) {}
  }

  /* ---------- saving ---------- */
  function setStatus(s) { ui.status = s; renderFoot(); }
  function persist() {
    saveLocal();
    if (!dbDoc) { setStatus('local'); return; }
    setStatus('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; flush(); }, 400);
  }
  function flush() {
    if (!dbDoc) return;
    if (saving) { pendingFlush = true; return; }
    saving = true;
    dbDoc.set({ v: 2, items: state.items, cur: ui.cur, updatedAt: now() }).then(function () {
      saving = false;
      if (pendingFlush || saveTimer) { pendingFlush = false; if (!saveTimer) flush(); return; }
      setStatus('saved');
    }, function (e) {
      saving = false;
      pendingFlush = false;
      setStatus(e && e.code === 'invalid_argument' ? 'readonly' : 'error');
    });
  }
  function changed() { persist(); render(); }

  /* ---------- derived ---------- */
  function tracked() { return state.items.filter(function (i) { return !i.oneOff; }); }
  function oneOffs() { return state.items.filter(function (i) { return i.oneOff; }); }
  function buyList() {
    return state.items.filter(function (i) { return i.oneOff || i.level <= 1 || i.onList; }).sort(function (a, b) {
      return areaIdx(a.area) - areaIdx(b.area) || (a.oneOff ? 4 : a.level) - (b.oneOff ? 4 : b.level) || a.name.localeCompare(b.name);
    });
  }

  /* ---------- rendering ---------- */
  var ICON = {
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    cart: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4h2.5l2 11h10l2-8H7"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>',
    grip: '<svg viewBox="0 0 24 24" width="14" height="18" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>'
  };

  function render() {
    var active = document.activeElement;
    var key = active && active.getAttribute ? active.getAttribute('data-fk') : null;
    renderSummary();
    renderInventory();
    renderBuy();
    renderFoot();
    if (key) {
      var el = document.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      if (el && el !== document.activeElement) el.focus();
    }
  }

  function renderSummary() {
    var t = tracked();
    var out = t.filter(function (i) { return i.level === 0; }).length;
    var low = t.filter(function (i) { return i.level === 1; }).length;
    var buy = buyList().length;
    $('navcount').textContent = buy;
    if (!t.length && !buy) { $('summary').innerHTML = '<span>Nothing tracked yet</span>'; return; }
    $('summary').innerHTML =
      '<span><b>' + buy + '</b>to buy</span>' +
      '<span class="s-out"><b>' + out + '</b>out</span>' +
      '<span class="s-low"><b>' + low + '</b>low</span>' +
      '<span><b>' + t.length + '</b>tracked</span>';
  }

  function segHtml(it) {
    return '<div class="seg" role="group" aria-label="' + esc(it.name) + ' stock level">' + LEVELS.map(function (l, i) {
      return '<button type="button" data-act="lvl" data-id="' + it.id + '" data-lvl="' + i + '" data-fk="' + it.id + ':l' + i + '" aria-pressed="' + (it.level === i) + '">' + l + '</button>';
    }).join('') + '</div>';
  }

  function editorHtml(it) {
    return '<div class="ed">' +
      '<label for="edPrice">Price<input class="field" id="edPrice" type="number" inputmode="decimal" min="0" step="any" data-f="price" data-id="' + it.id + '" data-fk="ed:price" value="' + (it.price == null ? '' : it.price) + '" placeholder="0.00"></label>' +
      '<label for="edUnit">Per<select class="field" id="edUnit" data-f="unit" data-id="' + it.id + '" data-fk="ed:unit">' +
        UNITS.map(function (u) { return '<option value="' + u.id + '"' + (u.id === it.unit ? ' selected' : '') + '>' + u.label + '</option>'; }).join('') + '</select></label>' +
      '<label for="edQty">Buy next trip<span class="qtyrow"><input class="field" id="edQty" type="number" inputmode="decimal" min="0" step="any" data-f="qty" data-id="' + it.id + '" data-fk="ed:qty" value="' + it.qty + '"><span class="u" id="edUnitLbl">' + esc(unitOf(it.unit).short) + '</span></span></label>' +
      '<button type="button" class="btn sm" data-act="ed-done" data-id="' + it.id + '" data-fk="ed:done">Done</button></div>';
  }

  function rowHtml(it) {
    if (ui.removing === it.id) {
      return '<li class="item removing"><div class="nm">Remove <strong>' + esc(it.name) + '</strong>?</div>' +
        '<div class="more"><button type="button" class="btn sm danger" data-act="rm-yes" data-id="' + it.id + '" data-fk="' + it.id + ':rmy">Remove</button>' +
        '<button type="button" class="btn sm" data-act="rm-no" data-fk="' + it.id + ':rmn">Keep</button></div></li>';
    }
    var auto = it.level <= 1;
    var onList = auto || it.onList;
    var editing = ui.editing === it.id;
    var chip = '<button type="button" class="pbtn' + (it.price == null ? '' : ' has') + '" data-act="edit" data-id="' + it.id + '" data-fk="' + it.id + ':chip" data-chip="' + it.id + '" aria-expanded="' + editing + '" aria-label="Price and quantity for ' + esc(it.name) + '">' + esc(priceChip(it)) + '</button>';
    var seg = '', listBtn = '';
    if (!it.oneOff) {
      seg = segHtml(it);
      listBtn = '<button type="button" class="iconbtn" data-act="list" data-id="' + it.id + '" data-fk="' + it.id + ':list" aria-pressed="' + onList + '"' + (auto ? ' disabled' : '') +
        ' title="' + (auto ? 'Already on your list' : onList ? 'Take off the list' : 'Add to the list') + '" aria-label="' + (auto ? esc(it.name) + ' is already on the list' : onList ? 'Take ' + esc(it.name) + ' off the list' : 'Add ' + esc(it.name) + ' to the list') + '">' + ICON.cart + '</button>';
    }
    // Handle used to drag the item to another shelf (one-time buys have no shelf, so no handle)
    var grip = it.oneOff ? '' : '<button type="button" class="grip" data-drag="' + it.id + '" data-fk="' + it.id + ':drag" title="Drag to another shelf" aria-label="Move ' + esc(it.name) + ' to another shelf. Drag it, or press the arrow keys.">' + ICON.grip + '</button>';
    return '<li class="item"><div class="top">' + grip + '<div class="nm"><span class="name">' + esc(it.name) + '</span>' +
      (it.oneOff ? '' : '<span class="when' + (isStale(it) ? ' stale' : '') + '">' + ago(it.at) + '</span>') + '</div>' + chip + '</div>' +
      '<div class="mid">' + seg + '<div class="more">' + listBtn +
      '<button type="button" class="iconbtn" data-act="rm-ask" data-id="' + it.id + '" data-fk="' + it.id + ':rm" title="Remove" aria-label="Remove ' + esc(it.name) + '">' + ICON.x + '</button>' +
      '</div></div>' + (editing ? editorHtml(it) : '') + '</li>';
  }

  function emptyShelf(a) {
    var list = SAMPLE[a.id];
    return '<div class="hint">Nothing on this shelf yet. Add items with ' + a.label + ' selected above' +
      (list ? ', or <button type="button" class="link" data-act="sample-area" data-a="' + a.id + '" data-fk="sa:' + a.id + '">add ' + list.length + ' common ones</button>' : '') + '.</div>';
  }

  function renderInventory() {
    var host = $('inventory');
    var t = tracked(), oo = oneOffs();
    $('filters').hidden = !t.length;
    var html = '';
    if (!t.length) {
      var n = 0;
      AREAS.forEach(function (a) { n += (SAMPLE[a.id] || []).length; });
      html += '<div class="empty"><h2>Start with what you usually keep</h2>' +
        '<p>Type your regular items in the box above, separated by commas, and pick Pantry, Fridge, Freezer or Bathroom first. Tap how much is left of each. Anything marked Low or Out lands on your To buy list. Use the price button on an item to add a price per piece or per weight. Drag the dotted handle on an item to move it to another shelf.</p>' +
        '<button type="button" class="btn" data-act="sample" data-fk="sample">Or start with ' + n + ' common staples</button></div>';
    }
    var f = ui.filter, shown = 0, inner = '';
    if (t.length) {
      AREAS.forEach(function (a) {
        var all = t.filter(function (i) { return i.area === a.id; });
        var rows = all.filter(function (i) { return f === 'all' || (f === 'low' && i.level <= 1) || (f === 'stale' && isStale(i)); });
        if (!rows.length && !(f === 'all' && !all.length)) return;
        shown += rows.length;
        var low = all.filter(function (i) { return i.level <= 1; }).length;
        inner += '<section class="area" data-area="' + a.id + '"><div class="rail"><h2>' + a.label + '</h2><span class="count">' +
          (all.length ? all.length + (all.length === 1 ? ' item' : ' items') + (low ? ' · ' + low + ' low or out' : '') : 'empty') + '</span></div>' +
          '<div class="shelves">' + (rows.length ? '<ul class="items">' + rows.map(rowHtml).join('') + '</ul>' : emptyShelf(a)) + '</div></section>';
      });
    }
    if (oo.length && f === 'all') {
      inner += '<section class="area" data-area="note"><div class="rail"><h2>One-time buys</h2><span class="count">' + oo.length + (oo.length === 1 ? ' item' : ' items') + '</span></div>' +
        '<div class="shelves"><ul class="items">' + oo.map(rowHtml).join('') + '</ul></div></section>';
    }
    if (inner) html += '<div class="cabinet">' + inner + '</div>';
    if (t.length && !shown) html += '<p class="none">' + (f === 'low' ? 'Nothing is low or out right now.' : 'Everything has been checked in the last two weeks.') + '</p>';
    host.innerHTML = html;
  }

  function reasonPill(it) {
    if (it.oneOff) return '<span class="pill">One-time</span>';
    if (it.level === 0) return '<span class="pill out">Out</span>';
    if (it.level === 1) return '<span class="pill low">Low</span>';
    return '<span class="pill">Added</span>';
  }

  function renderBuy() {
    var list = buyList();
    var h = '<div class="buyhead"><h2>To buy</h2><span class="n">' + list.length + '</span></div>';
    if (!list.length) {
      h += '<p class="none">' + (tracked().length ? 'Nothing is low or out. Your list is empty.' : 'Items you mark Low or Out show up here.') + '</p>';
    } else {
      var total = 0, priced = 0;
      list.forEach(function (i) { var c = cost(i); if (c != null) { total += c; priced++; } });
      if (priced) {
        h += '<p class="total">Estimated total <b>' + esc(money(total)) + '</b>' + (priced < list.length ? '<span>' + (list.length - priced) + ' without a price</span>' : '') + '</p>';
      } else {
        h += '<p class="total">Add prices with the price button on each item to see an estimated total.</p>';
      }
      AREAS.forEach(function (a) {
        var rows = list.filter(function (i) { return i.area === a.id; });
        if (!rows.length) return;
        h += '<p class="grp">' + a.label + '</p><ul class="buylist">' + rows.map(function (it) {
          var c = cost(it), q = qtyText(it);
          return '<li class="buyrow"><button type="button" class="got" data-act="bought" data-id="' + it.id + '" data-fk="' + it.id + ':got" aria-label="Bought ' + esc(it.name) + '" title="Bought it">' + ICON.check + '</button>' +
            '<span><span class="bname">' + esc(it.name) + '</span>' + (q ? '<span class="bqty">' + esc(q) + '</span>' : '') + '</span>' + reasonPill(it) +
            '<span class="cost' + (c == null ? ' na' : '') + '">' + (c == null ? '–' : esc(money(c))) + '</span></li>';
        }).join('') + '</ul>';
      });
      h += '<div class="actions"><button type="button" class="btn sm" data-act="copy" data-fk="copy">Copy list</button>';
      if (ui.confirmAll) {
        h += '<span class="ask">Mark all ' + list.length + ' as bought and restocked?</span>' +
          '<button type="button" class="btn sm primary" data-act="bought-all" data-fk="ball">Yes, restock all</button>' +
          '<button type="button" class="btn sm" data-act="bought-all-no" data-fk="ballno">Cancel</button>';
      } else {
        h += '<button type="button" class="btn sm" data-act="bought-all-ask" data-fk="baskall">Bought everything</button>';
      }
      h += '</div>';
      if (ui.copyText) h += '<label class="sr" for="copyBox">List text</label><textarea class="field copybox" id="copyBox" readonly>' + esc(ui.copyText) + '</textarea>';
    }
    $('buyPanel').innerHTML = h;
    var cb = $('copyBox');
    if (cb) { cb.focus(); cb.select(); }
  }

  var STATUS_TEXT = {
    loading: 'Loading your saved list…',
    stale: 'Your saved list is slow to load. Showing the last copy on this device.',
    saving: 'Saving…',
    saved: 'Saved',
    local: 'Saved on this device only',
    error: "Couldn't save. Your changes are still on screen.",
    readonly: "View only: changes won't be saved"
  };
  function renderFoot() {
    var bad = ui.status === 'error' || ui.status === 'readonly' || ui.status === 'stale';
    var h = '<span class="st' + (bad ? ' bad' : '') + '" role="status">' + STATUS_TEXT[ui.status] + '</span>';
    if (state.items.length) {
      h += '<span class="row">';
      if (ui.confirmClear) {
        h += 'Delete all ' + state.items.length + ' items? <button type="button" class="btn sm danger" data-act="clear-yes" data-fk="cly">Delete everything</button><button type="button" class="btn sm" data-act="clear-no" data-fk="clno">Cancel</button>';
      } else {
        if (dl) h += '<button type="button" class="link" data-act="export" data-fk="export">Export CSV</button>';
        h += '<button type="button" class="link" data-act="clear-ask" data-fk="clask">Clear all items</button>';
      }
      h += '</span>';
    }
    $('foot').innerHTML = h;
  }

  /* ---------- toast / undo ---------- */
  function toast(msg, withUndo) {
    $('toastMsg').textContent = msg;
    $('toastUndo').hidden = !withUndo;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').hidden = true; undoSnap = null; }, 8000);
  }
  function snapshot() { undoSnap = JSON.parse(JSON.stringify(state.items)); }

  /* ---------- actions ---------- */
  function markBought(it) {
    if (it.oneOff) { state.items = state.items.filter(function (x) { return x.id !== it.id; }); return; }
    it.level = 3; it.onList = false; it.at = now();
  }

  function addNames(names, area, once) {
    var added = 0;
    names.forEach(function (raw) {
      var name = capital(raw.trim().replace(/\s+/g, ' ')).slice(0, 80);
      if (!name) return;
      var dupe = state.items.some(function (i) { return !once && !i.oneOff && i.area === area && i.name.toLowerCase() === name.toLowerCase(); });
      if (dupe) return;
      state.items.push({ id: uid(), name: name, area: area, level: 3, onList: !!once, oneOff: !!once, at: now(), price: null, unit: 'pc', qty: 1 });
      added++;
    });
    return added;
  }

  function listText() {
    var d = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    var out = 'Grocery list, ' + d;
    var list = buyList();
    AREAS.forEach(function (a) {
      var rows = list.filter(function (i) { return i.area === a.id; });
      if (!rows.length) return;
      out += '\n\n' + a.label;
      rows.forEach(function (i) {
        var q = qtyText(i);
        out += '\n[ ] ' + i.name + (q ? ' ' + q : '') + (i.oneOff ? '' : i.level === 0 ? ' (out)' : i.level === 1 ? ' (low)' : '');
      });
    });
    var total = 0, priced = 0;
    list.forEach(function (i) { var c = cost(i); if (c != null) { total += c; priced++; } });
    if (priced) out += '\n\nEstimated total: ' + money(total);
    return out;
  }

  function csvCell(v) {
    v = String(v == null ? '' : v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function csvText() {
    var rows = [['name', 'area', 'stock', 'price', 'price_per', 'buy_qty', 'est_cost', 'on_list', 'one_time', 'last_checked']];
    state.items.slice().sort(function (a, b) { return areaIdx(a.area) - areaIdx(b.area) || a.name.localeCompare(b.name); }).forEach(function (i) {
      var c = cost(i);
      rows.push([i.name, i.area, i.oneOff ? '' : LEVELS[i.level], i.price == null ? '' : i.price, unitOf(i.unit).label, i.qty, c == null ? '' : c,
        (i.oneOff || i.level <= 1 || i.onList) ? 'yes' : 'no', i.oneOff ? 'yes' : 'no', i.at ? new Date(i.at).toISOString().slice(0, 10) : '']);
    });
    return '﻿' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n');
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t || t.disabled) return;
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    var it = id ? find(id) : null;

    switch (act) {
      case 'lvl':
        if (!it) return;
        it.level = Number(t.getAttribute('data-lvl'));
        it.at = now();
        changed();
        break;
      case 'list':
        if (!it || it.level <= 1) return;
        it.onList = !it.onList;
        changed();
        break;
      case 'edit':
        if (!it) return;
        ui.editing = ui.editing === id ? null : id;
        ui.removing = null;
        render();
        if (ui.editing && $('edPrice')) $('edPrice').focus();
        break;
      case 'ed-done':
        ui.editing = null;
        render();
        var chipEl = document.querySelector('[data-chip="' + id + '"]');
        if (chipEl) chipEl.focus();
        break;
      case 'rm-ask': ui.removing = id; ui.editing = null; render(); break;
      case 'rm-no': ui.removing = null; render(); break;
      case 'rm-yes':
        snapshot();
        state.items = state.items.filter(function (x) { return x.id !== id; });
        ui.removing = null;
        changed();
        toast('Removed', true);
        break;
      case 'bought':
        if (!it) return;
        snapshot();
        var nm = it.name;
        markBought(it);
        changed();
        toast(nm + ' marked as stocked', true);
        break;
      case 'bought-all-ask': ui.confirmAll = true; render(); break;
      case 'bought-all-no': ui.confirmAll = false; render(); break;
      case 'bought-all':
        snapshot();
        var n = buyList().length;
        buyList().forEach(markBought);
        ui.confirmAll = false;
        changed();
        toast(n + ' items marked as stocked', true);
        break;
      case 'copy':
        var text = listText();
        ui.copyText = null;
        var done = function () { toast('List copied', false); };
        var fail = function () { ui.copyText = text; render(); };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
          else fail();
        } catch (err) { fail(); }
        break;
      case 'export':
        if (!dl) return;
        dl.save({ filename: 'pantry-check.csv', data: csvText() }).then(function () { toast('CSV saved', false); }, function (err) {
          if (!err || err.code !== 'declined') toast("Couldn't save the CSV here", false);
        });
        break;
      case 'sample':
        var c = 0;
        AREAS.forEach(function (a) { c += addNames(SAMPLE[a.id], a.id, false); });
        changed();
        toast(c + ' staples added. Set the real level for each one.', false);
        break;
      case 'sample-area':
        var aid = t.getAttribute('data-a');
        var c2 = addNames(SAMPLE[aid] || [], aid, false);
        changed();
        toast(c2 + ' items added. Set the real level for each one.', false);
        break;
      case 'clear-ask': ui.confirmClear = true; render(); break;
      case 'clear-no': ui.confirmClear = false; render(); break;
      case 'clear-yes':
        snapshot();
        state.items = [];
        ui.confirmClear = false; ui.removing = null; ui.editing = null; ui.confirmAll = false;
        changed();
        toast('Cleared everything', true);
        break;
      case 'filter':
        ui.filter = t.getAttribute('data-f');
        Array.prototype.forEach.call(document.querySelectorAll('#filters .chip'), function (b) {
          b.setAttribute('aria-pressed', String(b === t));
        });
        render();
        break;
      case 'view':
        ui.view = t.getAttribute('data-v');
        $('cols').setAttribute('data-view', ui.view);
        Array.prototype.forEach.call(document.querySelectorAll('#viewswitch button'), function (b) {
          b.setAttribute('aria-pressed', String(b === t));
        });
        break;
      case 'undo':
        if (undoSnap) {
          state.items = undoSnap.map(clean).filter(Boolean);
          undoSnap = null;
          ui.removing = null; ui.editing = null;
          $('toast').hidden = true;
          changed();
        }
        break;
    }
  });

  /* Price, unit and quantity edits: update the model and the To buy slip, but leave the open editor alone. */
  function onField(e) {
    var t = e.target;
    var f = t.getAttribute ? t.getAttribute('data-f') : null;
    if (!f) return;
    var it = find(t.getAttribute('data-id'));
    if (!it) return;
    if (f === 'price') {
      var v = parseFloat(t.value);
      it.price = isFinite(v) && v >= 0 ? v : null;
    } else if (f === 'unit') {
      it.unit = unitOf(t.value).id;
      var lbl = $('edUnitLbl');
      if (lbl) lbl.textContent = unitOf(it.unit).short;
    } else if (f === 'qty') {
      var q = parseFloat(t.value);
      it.qty = isFinite(q) && q > 0 ? q : 1;
    }
    var chip = document.querySelector('[data-chip="' + it.id + '"]');
    if (chip) {
      chip.textContent = priceChip(it);
      chip.className = 'pbtn' + (it.price == null ? '' : ' has');
    }
    renderBuy();
    persist();
  }
  document.addEventListener('input', onField);
  document.addEventListener('change', onField);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('.ed')) {
      e.preventDefault();
      var done = document.querySelector('[data-act="ed-done"]');
      if (done) done.click();
    }
  });

  $('cur').addEventListener('input', function () {
    ui.cur = $('cur').value.trim().slice(0, 4);
    renderInventory();
    renderBuy();
    persist();
  });

  $('addForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('addName');
    var names = input.value.split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!names.length) { input.focus(); return; }
    var once = $('addOnce').checked;
    var area = $('addArea').value;
    var n = addNames(names, area, once);
    input.value = '';
    input.focus();
    if (n) {
      changed();
      if (once) toast('Added to your list', false);
    } else {
      toast('Already on your ' + areaLabel(area).toLowerCase() + ' list', false);
    }
  });

  /* ---------- move items between shelves ---------- */
  /* Drag the dotted handle onto another shelf (works with mouse, finger and pen).
     Keyboard: focus the handle and press the arrow keys to move to the next or previous shelf. */
  var drag = null; // the drag in progress: { id, ghost, source, dx, dy, x, y, timer }

  function moveItem(it, areaId) {
    if (!it || it.area === areaId) return;
    // Don't create a duplicate if the target shelf already has an item with this name
    var dupe = state.items.some(function (i) { return i !== it && !i.oneOff && i.area === areaId && i.name.toLowerCase() === it.name.toLowerCase(); });
    if (dupe) { toast(it.name + ' is already on your ' + areaLabel(areaId).toLowerCase() + ' list', false); return; }
    snapshot();                       // so "Undo" can put it back
    it.area = areaId;
    changed();                        // saves and redraws
    toast('Moved ' + it.name + ' to ' + areaLabel(areaId), true);
  }

  // The shelf under a screen position (the "One-time buys" shelf is not a place to drop)
  function areaAt(x, y) {
    var el = document.elementFromPoint(x, y);
    var sec = el && el.closest ? el.closest('.area[data-area]') : null;
    return sec && sec.getAttribute('data-area') !== 'note' ? sec : null;
  }

  // Outline the shelf the item would land on (not the one it is already on)
  function highlightDrop() {
    var sec = areaAt(drag.x, drag.y);
    var it = find(drag.id);
    if (sec && it && sec.getAttribute('data-area') === it.area) sec = null;
    var cur = document.querySelector('.area.drop');
    if (cur && cur !== sec) cur.classList.remove('drop');
    if (sec && sec !== cur) sec.classList.add('drop');
  }

  // Remove the floating copy and all drag styling
  function endDrag() {
    if (!drag) return;
    clearInterval(drag.timer);
    if (drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    if (drag.source) drag.source.classList.remove('dragging');
    var cur = document.querySelector('.area.drop');
    if (cur) cur.classList.remove('drop');
    document.body.classList.remove('moving');
    drag = null;
  }

  document.addEventListener('pointerdown', function (e) {
    var g = e.target.closest ? e.target.closest('[data-drag]') : null;
    if (!g || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
    var li = g.closest('.item');
    var it = find(g.getAttribute('data-drag'));
    if (!li || !it) return;
    e.preventDefault();               // no text selection or page scroll while dragging
    var box = li.getBoundingClientRect();
    // A floating copy of the item follows the pointer
    var ghost = li.cloneNode(true);
    ghost.className = 'item ghost';
    ghost.setAttribute('aria-hidden', 'true');
    Array.prototype.forEach.call(ghost.querySelectorAll('[data-fk]'), function (n) { n.removeAttribute('data-fk'); });
    Array.prototype.forEach.call(ghost.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
    ghost.style.width = box.width + 'px';
    ghost.style.left = box.left + 'px';
    ghost.style.top = box.top + 'px';
    document.body.appendChild(ghost);
    li.classList.add('dragging');
    document.body.classList.add('moving');
    drag = { id: it.id, ghost: ghost, source: li, dx: e.clientX - box.left, dy: e.clientY - box.top, x: e.clientX, y: e.clientY, timer: null };
    try { g.setPointerCapture(e.pointerId); } catch (err) {}
    // Scroll the page when the pointer is near the top or bottom edge, and keep the outline current
    drag.timer = setInterval(function () {
      if (!drag) return;
      if (drag.y < 60) window.scrollBy(0, -14);
      else if (drag.y > window.innerHeight - 60) window.scrollBy(0, 14);
      highlightDrop();
    }, 30);
    highlightDrop();
  });

  document.addEventListener('pointermove', function (e) {
    if (!drag) return;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.ghost.style.left = (e.clientX - drag.dx) + 'px';
    drag.ghost.style.top = (e.clientY - drag.dy) + 'px';
    highlightDrop();
  });

  document.addEventListener('pointerup', function (e) {
    if (!drag) return;
    var sec = areaAt(e.clientX, e.clientY);
    var id = drag.id;
    endDrag();
    if (sec) moveItem(find(id), sec.getAttribute('data-area'));
  });
  document.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { endDrag(); return; }
    var g = e.target.closest ? e.target.closest('[data-drag]') : null;
    if (!g) return;
    var step = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    var it = find(g.getAttribute('data-drag'));
    var next = it ? AREAS[areaIdx(it.area) + step] : null;
    if (next) moveItem(it, next.id);
  });

  /* ---------- start ---------- */
  $('today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  loadLocal();
  $('cur').value = ui.cur;
  render();

  /* ---------- storage hook (used by firebase.js) ---------- */
  var unsub = null;

  function stopListening() {
    if (unsub) { try { unsub(); } catch (e) {} unsub = null; }
    clearTimeout(loadTimer);
    dbDoc = null;
  }

  function attach(doc) {
    stopListening();
    dbDoc = doc;
    setStatus('loading');
    loadTimer = setTimeout(function () { if (ui.status === 'loading') setStatus('stale'); }, 10000);
    unsub = dbDoc.onSnapshot(function (snap) {
      if (!snap.metadata.fromCache) {
        clearTimeout(loadTimer);
        if (ui.status === 'loading' || ui.status === 'stale') setStatus('saved');
      }
      if (snap.metadata.hasPendingWrites || saveTimer || saving) return;
      if (snap.exists()) { // Updated to support modular Firestore DocumentSnapshot .exists() function call
        var d = snap.data();
        if (d && Array.isArray(d.items)) {
          var next = d.items.map(clean).filter(Boolean);
          var cur = typeof d.cur === 'string' ? d.cur.slice(0, 4) : ui.cur;
          if (JSON.stringify(next) !== JSON.stringify(state.items) || cur !== ui.cur) {
            state.items = next;
            ui.cur = cur;
            if (document.activeElement !== $('cur')) $('cur').value = cur;
            saveLocal();
            render();
          }
        }
      }
    }, function () {
      stopListening();
      setStatus('error');
    });
  }

  /* Stop syncing but keep what's on screen (signed out at page load). */
  function detach() {
    stopListening();
    setStatus('local');
  }

  /* Signed out on purpose: clear this device so the next person doesn't see your list. */
  function reset() {
    stopListening();
    state.items = [];
    ui.editing = null; ui.removing = null; ui.confirmAll = false; ui.confirmClear = false; ui.copyText = null;
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
    render();
    setStatus('local');
  }

  /* CSV export saves through the browser's normal download. */
  dl = {
    save: function (req) {
      try {
        var blob = new Blob([req.data], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = req.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        return Promise.resolve({ status: 'saved' });
      } catch (e) { return Promise.reject(e); }
    }
  };

  setStatus('local');
  window.pantryApp = { attach: attach, detach: detach, reset: reset };
})();