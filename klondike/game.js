// klondike/game.js — Klondike Solitaire

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const NUM_TABLEAU = 7;
  const NUM_FOUND   = 4;

  // ── State ────────────────────────────────────────────────────────────────────
  let stock       = [];
  let waste       = [];
  let foundations = [];   // [{ suit, cards: [] }, ...]
  let tableau     = [];   // 7 arrays of cards
  let drag        = null; // { source, colIdx?, fromCardIdx?, cards[], x, y, offsetX, offsetY }
  let history     = [];
  let moves       = 0;
  let startTime   = null;
  let timerInterval = null;
  let won         = false;
  let paused      = false;
  let pausedAt    = null;
  let showHints   = true;

  // ── Layout (computed on resize) ──────────────────────────────────────────────
  let CW, CH;
  let MARGIN_X, MARGIN_Y;
  let COL_X           = [];  // x positions for 7 columns
  let TOP_Y;                 // y of stock / waste / foundation row
  let TABLEAU_TOP;           // y where tableau columns start
  let FACE_DOWN_OVERLAP;     // px shown per face-down card
  let FACE_UP_OVERLAP;       // px shown per face-up card

  // ── Canvas ───────────────────────────────────────────────────────────────────
  const canvas = document.getElementById('gameCanvas');
  const ctx    = canvas.getContext('2d');

  function resize() {
    const wrapper  = canvas.parentElement;
    const W        = wrapper.clientWidth || 800;
    const isMobile = W <= 680;

    MARGIN_X = Math.round(W * (isMobile ? 0.008 : 0.012));
    CW       = Math.floor((W - MARGIN_X * (NUM_TABLEAU + 1)) / NUM_TABLEAU);

    if (isMobile) {
      CW = Math.floor(CW * 0.94);
      const wrapH = wrapper.clientHeight;
      if (wrapH > 100) CW = Math.min(CW, Math.floor(wrapH / 7));
    }

    CH       = Math.round(CW * (3.5 / 2.5));
    MARGIN_Y = Math.round(CH * 0.12);

    const colStep = (W - MARGIN_X * 2) / NUM_TABLEAU;
    COL_X = Array.from({ length: NUM_TABLEAU }, (_, i) => Math.round(MARGIN_X + i * colStep));

    TOP_Y       = MARGIN_Y;
    TABLEAU_TOP = TOP_Y + CH + MARGIN_Y * 2;

    FACE_DOWN_OVERLAP = Math.round(CH * 0.15);
    FACE_UP_OVERLAP   = Math.round(CH * 0.28);

    // On mobile, compress overlap so columns fit in available height
    if (isMobile) {
      const wrapH = wrapper.clientHeight;
      if (wrapH > 100) {
        const available = wrapH - TABLEAU_TOP - CH - MARGIN_Y;
        if (available > 0) {
          FACE_UP_OVERLAP   = Math.min(FACE_UP_OVERLAP,   Math.floor(available / 12));
          FACE_DOWN_OVERLAP = Math.min(FACE_DOWN_OVERLAP, FACE_UP_OVERLAP);
        }
      }
    }

    const dpr = window.devicePixelRatio || 1;
    let logicalH;
    if (isMobile && wrapper.clientHeight > 100) {
      logicalH = wrapper.clientHeight;
    } else {
      logicalH = TABLEAU_TOP + 12 * FACE_UP_OVERLAP + CH + MARGIN_Y;
    }

    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(logicalH * dpr);

    render();
  }

  // ── Column card y-position ───────────────────────────────────────────────────
  // Returns the canvas y of card at cardIdx in column colIdx.
  function colCardY(colIdx, cardIdx) {
    let y = TABLEAU_TOP;
    const col = tableau[colIdx];
    for (let i = 0; i < cardIdx; i++) {
      y += col[i].faceUp ? FACE_UP_OVERLAP : FACE_DOWN_OVERLAP;
    }
    return y;
  }

  // ── Game initialisation ──────────────────────────────────────────────────────
  function newGame() {
    clearInterval(timerInterval);
    won      = false;
    moves    = 0;
    drag     = null;
    paused   = false;
    pausedAt = null;
    history  = [];
    document.getElementById('btnPause').textContent = 'Pause';
    updateMoveCounter();
    updateTimer(0);

    const deck = shuffleDeck(createDeck());
    let idx = 0;

    // Deal tableau: column c gets c+1 cards, only the last is face-up
    tableau = [];
    for (let c = 0; c < NUM_TABLEAU; c++) {
      const col = [];
      for (let j = 0; j <= c; j++) {
        const card = deck[idx++];
        card.faceUp = (j === c);
        col.push(card);
      }
      tableau.push(col);
    }

    // Remaining 24 cards → stock (face-down)
    stock = deck.slice(idx).map(c => { c.faceUp = false; return c; });
    waste = [];

    foundations = SUITS.map(suit => ({ suit, cards: [] }));

    startTimer();
    render();
    hideWin();
  }

  // ── Snapshot / Undo ──────────────────────────────────────────────────────────
  function snapshot() {
    history.push({
      stock:       stock.map(c => ({ ...c })),
      waste:       waste.map(c => ({ ...c })),
      foundations: foundations.map(f => ({ suit: f.suit, cards: f.cards.map(c => ({ ...c })) })),
      tableau:     tableau.map(col => col.map(c => ({ ...c }))),
      moves,
    });
    if (history.length > 64) history.shift();
  }

  function undo() {
    if (!history.length) return;
    const prev  = history.pop();
    stock       = prev.stock;
    waste       = prev.waste;
    foundations = prev.foundations;
    tableau     = prev.tableau;
    moves       = prev.moves;
    drag        = null;
    won         = false;
    updateMoveCounter();
    hideWin();
    render();
  }

  // ── Move rules ───────────────────────────────────────────────────────────────
  function topCard(col) {
    return col.length ? col[col.length - 1] : null;
  }

  // Klondike tableau rule: place card on column only if one rank lower AND opposite color.
  // Kings go on empty columns only.
  function canPlaceOnTableau(card, targetCol) {
    if (targetCol.length === 0) return card.value === 13; // King on empty
    const top = topCard(targetCol);
    return top.faceUp &&
           card.value === top.value - 1 &&
           isRed(card) !== isRed(top);
  }

  function canPlaceOnFoundation(card, foundation) {
    if (!card.faceUp) return false;
    if (foundation.cards.length === 0) return card.rank === 'A' && card.suit === foundation.suit;
    const top = foundation.cards[foundation.cards.length - 1];
    return card.suit === foundation.suit && card.value === top.value + 1;
  }

  // A sequence is valid if all cards are face-up and each is one lower and opposite color.
  function isValidSequence(cards) {
    if (!cards.length || !cards[0].faceUp) return false;
    for (let i = 0; i < cards.length - 1; i++) {
      const a = cards[i], b = cards[i + 1];
      if (!b.faceUp || b.value !== a.value - 1 || isRed(a) === isRed(b)) return false;
    }
    return true;
  }

  // ── Stock / waste ────────────────────────────────────────────────────────────
  function drawFromStock() {
    if (stock.length === 0 && waste.length === 0) return;
    snapshot();
    if (stock.length === 0) {
      // Recycle: flip waste pile back to stock face-down
      stock = [...waste].reverse();
      stock.forEach(c => { c.faceUp = false; });
      waste = [];
    } else {
      const card = stock.pop();
      card.faceUp = true;
      waste.push(card);
    }
    moves++;
    updateMoveCounter();
    render();
  }

  // ── Source helpers ────────────────────────────────────────────────────────────
  function removeFromSource(d) {
    if (d.source === 'waste') {
      waste.pop();
    } else {
      tableau[d.colIdx].splice(d.fromCardIdx);
    }
  }

  // After removing cards from a tableau column, flip the newly exposed card if face-down.
  function maybeFlipSource(d) {
    if (d.source !== 'tableau') return;
    const col = tableau[d.colIdx];
    if (col.length > 0 && !col[col.length - 1].faceUp) {
      col[col.length - 1].faceUp = true;
    }
  }

  // ── Auto-foundation ───────────────────────────────────────────────────────────
  function tryAutoFoundation(card, removeFn) {
    for (const f of foundations) {
      if (canPlaceOnFoundation(card, f)) {
        snapshot();
        removeFn();
        f.cards.push(card);
        moves++;
        updateMoveCounter();
        checkWin();
        render();
        return true;
      }
    }
    return false;
  }

  // ── Canvas position ───────────────────────────────────────────────────────────
  function canvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Hit testing ───────────────────────────────────────────────────────────────
  // Returns { colIdx, fromCardIdx } or null. fromCardIdx === -1 means empty column slot.
  function hitTestTableau(x, y) {
    for (let c = 0; c < NUM_TABLEAU; c++) {
      if (x < COL_X[c] || x > COL_X[c] + CW) continue;
      const col = tableau[c];

      if (col.length === 0) {
        if (y >= TABLEAU_TOP && y <= TABLEAU_TOP + CH) return { colIdx: c, fromCardIdx: -1 };
        continue;
      }

      // Iterate from top card downward — highest index drawn last (on top)
      for (let k = col.length - 1; k >= 0; k--) {
        const cy = colCardY(c, k);
        if (y >= cy && y <= cy + CH) return { colIdx: c, fromCardIdx: k };
      }
    }
    return null;
  }

  // ── Pointer events ────────────────────────────────────────────────────────────
  canvas.addEventListener('pointerdown', function (e) {
    if (won || paused) return;
    const { x, y } = canvasPos(e);

    // ── Top row: stock and waste ──
    if (y >= TOP_Y && y <= TOP_Y + CH) {
      // Stock pile click → draw a card
      if (x >= COL_X[0] && x <= COL_X[0] + CW) {
        e.preventDefault();
        drawFromStock();
        return;
      }
      // Waste pile → start drag of top card
      if (x >= COL_X[1] && x <= COL_X[1] + CW && waste.length > 0) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        drag = {
          source:  'waste',
          cards:   [waste[waste.length - 1]],
          x, y,
          offsetX: x - COL_X[1],
          offsetY: y - TOP_Y,
        };
        render();
        return;
      }
      return; // clicked gap / foundation — no drag starts here
    }

    // ── Tableau ──
    const hit = hitTestTableau(x, y);
    if (!hit || hit.fromCardIdx === -1) return; // empty slot or miss — allow page scroll

    const col       = tableau[hit.colIdx];
    const dragCards = col.slice(hit.fromCardIdx);
    if (!isValidSequence(dragCards)) return; // face-down or broken sequence

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = {
      source:      'tableau',
      colIdx:       hit.colIdx,
      fromCardIdx:  hit.fromCardIdx,
      cards:        dragCards,
      x, y,
      offsetX: x - COL_X[hit.colIdx],
      offsetY: y - colCardY(hit.colIdx, hit.fromCardIdx),
    };
    render();
  });

  canvas.addEventListener('pointermove', function (e) {
    if (!drag) return;
    e.preventDefault();
    const { x, y } = canvasPos(e);
    drag.x = x;
    drag.y = y;
    render();
  });

  canvas.addEventListener('pointerup', function (e) {
    if (!drag) return;
    const d    = drag;
    drag       = null;
    const card = d.cards[0]; // bottom card of the dragged stack

    // Use center of the dragged card (not raw pointer) for hit detection
    const dragLeft = d.x - d.offsetX;
    const dragTop  = d.y - d.offsetY;
    const dragCX   = dragLeft + CW / 2;
    const dragCY   = dragTop  + CH / 2;

    // ── Foundation drop (single card only) ──
    if (d.cards.length === 1 && dragCY >= TOP_Y - CH * 0.5 && dragCY <= TOP_Y + CH + CH * 0.5) {
      for (let i = 0; i < NUM_FOUND; i++) {
        const fx = COL_X[3 + i];
        if (Math.abs(dragCX - (fx + CW / 2)) < CW * 0.55) {
          if (canPlaceOnFoundation(card, foundations[i])) {
            snapshot();
            removeFromSource(d);
            foundations[i].cards.push(card);
            moves++;
            updateMoveCounter();
            maybeFlipSource(d);
            checkWin();
            render();
            return;
          }
          break;
        }
      }
    }

    // ── Tableau drop: find closest column by center x ──
    let targetC = -1, bestDist = CW * 0.6; // threshold: within 60% of card width
    for (let c = 0; c < NUM_TABLEAU; c++) {
      const dist = Math.abs(dragCX - (COL_X[c] + CW / 2));
      if (dist < bestDist) { bestDist = dist; targetC = c; }
    }

    if (targetC >= 0 && (d.source !== 'tableau' || targetC !== d.colIdx)) {
      if (canPlaceOnTableau(card, tableau[targetC])) {
        snapshot();
        removeFromSource(d);
        tableau[targetC].push(...d.cards);
        moves++;
        updateMoveCounter();
        maybeFlipSource(d);
        render();
        return;
      }
    }

    render(); // invalid drop — card snaps back
  });

  canvas.addEventListener('pointercancel', function () {
    drag = null;
    render();
  });

  // Double-tap / click: auto-send top card to matching foundation
  canvas.addEventListener('dblclick', function (e) {
    if (won || paused) return;
    drag = null;
    const { x, y } = canvasPos(e);

    // Waste pile top card
    if (x >= COL_X[1] && x <= COL_X[1] + CW && y >= TOP_Y && y <= TOP_Y + CH && waste.length > 0) {
      tryAutoFoundation(waste[waste.length - 1], () => waste.pop());
      return;
    }

    // Tableau top card
    const hit = hitTestTableau(x, y);
    if (hit && hit.fromCardIdx !== -1) {
      const col = tableau[hit.colIdx];
      if (hit.fromCardIdx === col.length - 1 && col[hit.fromCardIdx].faceUp) {
        tryAutoFoundation(col[col.length - 1], () => col.pop());
      }
    }
  });

  // ── Rendering ────────────────────────────────────────────────────────────────
  function drawDropHighlight(x, y, w, h) {
    const radius = Math.max(4, w * 0.06);
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, x, y, w, h, radius);
    ctx.strokeStyle = 'rgba(74, 144, 217, 0.95)';
    ctx.lineWidth   = 3;
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.width  / dpr;
    const H   = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = '#1b5e20';
    ctx.fillRect(0, 0, W, H);

    // Precompute valid drop targets for hints
    const validTabCols  = new Set();
    const validFoundIdx = new Set();
    if (drag && showHints) {
      const card = drag.cards[0];
      for (let c = 0; c < NUM_TABLEAU; c++) {
        if (drag.source === 'tableau' && c === drag.colIdx) continue;
        if (canPlaceOnTableau(card, tableau[c])) validTabCols.add(c);
      }
      if (drag.cards.length === 1) {
        for (let i = 0; i < NUM_FOUND; i++) {
          if (canPlaceOnFoundation(card, foundations[i])) validFoundIdx.add(i);
        }
      }
    }

    // ── Stock ──
    const stockX = COL_X[0];
    if (stock.length > 0) {
      // Top of stock is always face-down; drawCard draws the back when faceUp === false
      drawCard(ctx, stock[stock.length - 1], stockX, TOP_Y, CW, CH);
    } else {
      drawEmptySlot(ctx, stockX, TOP_Y, CW, CH);
      ctx.save();
      ctx.font = `${Math.round(CH * 0.38)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.55; ctx.fillStyle = '#ffffff';
      ctx.fillText('↺', stockX + CW / 2, TOP_Y + CH / 2);
      ctx.restore();
    }
    // Stock count label
    ctx.save();
    ctx.font = `${Math.round(CW * 0.18)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(String(stock.length), stockX + CW / 2, TOP_Y + CH + 3);
    ctx.restore();

    // ── Waste ──
    const wasteX       = COL_X[1];
    const wasteDragged = drag && drag.source === 'waste';
    if (waste.length === 0) {
      drawEmptySlot(ctx, wasteX, TOP_Y, CW, CH);
    } else {
      // Show a peek of the card beneath the top card
      if (waste.length >= 2 && !wasteDragged) {
        ctx.save(); ctx.globalAlpha = 0.55;
        drawCard(ctx, waste[waste.length - 2],
          wasteX + Math.round(CW * 0.07), TOP_Y + Math.round(CH * 0.04), CW, CH);
        ctx.restore();
      }
      if (wasteDragged) {
        ctx.save(); ctx.globalAlpha = 0.22;
        drawCard(ctx, waste[waste.length - 1], wasteX, TOP_Y, CW, CH);
        ctx.restore();
      } else {
        drawCard(ctx, waste[waste.length - 1], wasteX, TOP_Y, CW, CH);
      }
    }

    // ── Foundations ──
    for (let i = 0; i < NUM_FOUND; i++) {
      const fx = COL_X[3 + i];
      const f  = foundations[i];
      if (f.cards.length === 0) {
        drawEmptySlot(ctx, fx, TOP_Y, CW, CH);
        ctx.save();
        ctx.font = `${Math.round(CH * 0.35)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.globalAlpha = 0.35; ctx.fillStyle = SUIT_COLORS[f.suit];
        ctx.fillText(SUIT_SYMBOLS[f.suit], fx + CW / 2, TOP_Y + CH / 2);
        ctx.restore();
      } else {
        drawCard(ctx, f.cards[f.cards.length - 1], fx, TOP_Y, CW, CH);
      }
      if (showHints && validFoundIdx.has(i)) drawDropHighlight(fx, TOP_Y, CW, CH);
    }

    // ── Tableau ──
    for (let c = 0; c < NUM_TABLEAU; c++) {
      const col = tableau[c];
      const cx  = COL_X[c];

      if (col.length === 0) {
        drawEmptySlot(ctx, cx, TABLEAU_TOP, CW, CH);
        if (showHints && validTabCols.has(c)) drawDropHighlight(cx, TABLEAU_TOP, CW, CH);
        continue;
      }

      let y = TABLEAU_TOP;
      for (let k = 0; k < col.length; k++) {
        const card      = col[k];
        const isDragged = drag && drag.source === 'tableau' &&
                          drag.colIdx === c && k >= drag.fromCardIdx;

        if (isDragged) {
          // Draw ghost at source position for the first dragged card only
          if (k === drag.fromCardIdx) {
            ctx.save(); ctx.globalAlpha = 0.22;
            drawCard(ctx, card, cx, y, CW, CH);
            ctx.restore();
          }
          if (k < col.length - 1) y += card.faceUp ? FACE_UP_OVERLAP : FACE_DOWN_OVERLAP;
          continue;
        }

        drawCard(ctx, card, cx, y, CW, CH);
        if (k < col.length - 1) y += card.faceUp ? FACE_UP_OVERLAP : FACE_DOWN_OVERLAP;
      }

      // Drop highlight on top of valid target columns
      if (showHints && validTabCols.has(c)) {
        drawDropHighlight(cx, colCardY(c, col.length - 1), CW, CH);
      }
    }

    // ── Drag stack (floats above everything) ──
    if (drag) {
      const dx = drag.x - drag.offsetX;
      const dy = drag.y - drag.offsetY;
      ctx.save();
      ctx.shadowColor   = 'rgba(0,0,0,0.30)';
      ctx.shadowBlur    = 10;
      ctx.shadowOffsetX = 3;
      ctx.shadowOffsetY = 5;
      for (let i = 0; i < drag.cards.length; i++) {
        drawCard(ctx, drag.cards[i], dx, dy + i * FACE_UP_OVERLAP, CW, CH);
      }
      ctx.restore();
    }

    // ── Pause overlay ──
    if (paused) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(0, 0, W, H);
      ctx.font = `bold ${Math.round(CH * 0.55)}px Arial, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText('PAUSED', W / 2, H / 2);
      ctx.font = `${Math.round(CH * 0.22)}px Arial, system-ui, sans-serif`;
      ctx.fillStyle = '#555555';
      ctx.fillText('Press Resume to continue', W / 2, H / 2 + Math.round(CH * 0.65));
      ctx.restore();
    }
  }

  // ── Win detection ────────────────────────────────────────────────────────────
  function checkWin() {
    if (foundations.every(f => f.cards.length === 13)) {
      won = true;
      clearInterval(timerInterval);
      showWin();
    }
  }

  function showWin() {
    const overlay = document.getElementById('winOverlay');
    const stats   = document.getElementById('winStats');
    overlay.classList.add('visible');
    const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
    stats.textContent = `${moves} moves · ${formatTime(elapsed)}`;
  }

  function hideWin() {
    document.getElementById('winOverlay').classList.remove('visible');
  }

  // ── Timer ─────────────────────────────────────────────────────────────────────
  function startTimer() {
    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!paused) updateTimer(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
  }

  function updateTimer(s) {
    document.getElementById('timer').textContent = formatTime(s);
  }

  function formatTime(s) {
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function updateMoveCounter() {
    document.getElementById('moveCount').textContent = moves;
  }

  // ── Pause / hints toggles ─────────────────────────────────────────────────────
  function togglePause() {
    if (won) return;
    const btn = document.getElementById('btnPause');
    if (!paused) {
      clearInterval(timerInterval);
      pausedAt = Date.now();
      paused   = true;
      drag     = null;
      btn.textContent = 'Resume';
    } else {
      startTime += Date.now() - pausedAt;
      pausedAt   = null;
      paused     = false;
      btn.textContent = 'Pause';
      startTimer();
    }
    render();
  }

  function toggleHints() {
    showHints = !showHints;
    const btn = document.getElementById('btnHints');
    if (showHints) {
      btn.textContent = 'Hints: On';
      btn.classList.replace('btn-toggle-off', 'btn-toggle-on');
    } else {
      btn.textContent = 'Hints: Off';
      btn.classList.replace('btn-toggle-on', 'btn-toggle-off');
    }
    render();
  }

  // ── Button wiring ─────────────────────────────────────────────────────────────
  document.getElementById('btnNew').addEventListener('click', newGame);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnPause').addEventListener('click', togglePause);
  document.getElementById('btnHints').addEventListener('click', toggleHints);
  document.getElementById('winNewGame').addEventListener('click', newGame);

  // ── Responsive resize ─────────────────────────────────────────────────────────
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  resize();
  newGame();

}());
