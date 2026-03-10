// bakers-dozen/game.js — Baker's Dozen Solitaire

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const NUM_COLS    = 13;
  const NUM_FOUND   = 4;
  const COL_OVERLAP = 0.28;  // fraction of card height each overlapping card shows

  // ── State ────────────────────────────────────────────────────────────────────
  let tableau     = [];
  let foundations = [];
  let drag        = null;  // { colIndex, card, x, y, offsetX, offsetY }
  let history     = [];
  let moves       = 0;
  let startTime   = null;
  let timerInterval = null;
  let won         = false;
  let paused      = false;
  let pausedAt    = null;   // Date.now() when paused; used to offset startTime on resume
  let showHints   = true;

  // ── Layout (computed on resize) ──────────────────────────────────────────────
  let CW, CH;
  let MARGIN_X, MARGIN_Y;
  let COL_X        = [];
  let COL_ROW      = [];  // which display row each column belongs to
  let FOUND_X      = [];
  let FOUND_Y;
  let TABLEAU_TOP;
  let ROW_Y        = [];  // canvas y-offset for each display row
  let COLS_PER_ROW = NUM_COLS;
  let NUM_ROWS     = 1;
  let effectiveOverlap = COL_OVERLAP;

  // ── Canvas setup ────────────────────────────────────────────────────────────
  const canvas = document.getElementById('gameCanvas');
  const ctx    = canvas.getContext('2d');

  function resize() {
    const wrapper = canvas.parentElement;
    const W = wrapper.clientWidth || 800;

    const isMobile = W <= 680;

    // On mobile: split 13 cols into 2 rows (7 + 6) so cards are roughly twice as wide
    COLS_PER_ROW = isMobile ? 7 : NUM_COLS;
    NUM_ROWS     = Math.ceil(NUM_COLS / COLS_PER_ROW);

    MARGIN_X = Math.round(W * (isMobile ? 0.006 : 0.012));
    CW       = Math.floor((W - MARGIN_X * (COLS_PER_ROW + 1)) / COLS_PER_ROW);
    if (isMobile) {
      CW = Math.floor(CW * 0.90);  // slightly smaller cards on mobile
      // Also cap by available wrapper height: total 2-row canvas height ≈ 10 × CW,
      // so CW_max = wrapperH / 10. Keeps cards fully visible without scrolling.
      const wrapH = wrapper.clientHeight;
      if (wrapH > 100) CW = Math.min(CW, Math.floor(wrapH / 10));
    }
    CH       = Math.round(CW * (3.5 / 2.5));
    MARGIN_Y = Math.round(CH * 0.12);

    effectiveOverlap = isMobile ? 0.24 : COL_OVERLAP;

    // Foundations
    FOUND_Y = MARGIN_Y;
    const foundTotalW = NUM_FOUND * CW + (NUM_FOUND - 1) * MARGIN_X;
    const foundStartX = W - foundTotalW - MARGIN_X;
    FOUND_X = Array.from({ length: NUM_FOUND }, (_, i) => foundStartX + i * (CW + MARGIN_X));

    // Column x positions and row assignments
    const colStep = (W - MARGIN_X * 2) / COLS_PER_ROW;
    COL_X   = [];
    COL_ROW = [];
    for (let c = 0; c < NUM_COLS; c++) {
      COL_ROW[c] = Math.floor(c / COLS_PER_ROW);
      COL_X[c]   = MARGIN_X + (c % COLS_PER_ROW) * colStep;
    }

    // Each row gets a fixed vertical slot; on mobile use 8-card max (columns start at 4)
    // to avoid the large gap between row 1 and row 2. Desktop keeps 13-card worst case.
    const overlap         = Math.round(CH * effectiveOverlap);
    const maxStackVisible = isMobile ? 8 : 13;
    const rowSlotH        = CH + (maxStackVisible - 1) * overlap + MARGIN_Y * 2;
    const firstRowTop  = FOUND_Y + CH + Math.round(MARGIN_Y * 1.5);
    TABLEAU_TOP        = firstRowTop;  // backwards-compat alias for row 0
    ROW_Y = Array.from({ length: NUM_ROWS }, (_, r) => firstRowTop + r * rowSlotH);

    // Scale canvas to device pixels for sharp rendering on HiDPI/retina screens.
    // All layout variables stay in CSS pixels; render() applies the dpr transform.
    const dpr     = window.devicePixelRatio || 1;
    const logicalH = Math.max(ROW_Y[NUM_ROWS - 1] + rowSlotH, CH * 7);
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(logicalH * dpr);

    render();
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
    deck.forEach(c => c.faceUp = true);

    tableau = Array.from({ length: NUM_COLS }, (_, i) =>
      deck.slice(i * 4, i * 4 + 4)
    );

    // Kings move to the bottom of their pile (Baker's Dozen rule)
    tableau.forEach(col => {
      const kings = col.filter(c => c.rank === 'K');
      const rest  = col.filter(c => c.rank !== 'K');
      col.length = 0;
      col.push(...rest, ...kings);
    });

    foundations = SUITS.map(suit => ({ suit, cards: [] }));

    startTimer();
    render();
    hideWin();
  }

  // ── Snapshot / Undo ──────────────────────────────────────────────────────────
  function snapshot() {
    history.push({
      tableau:     tableau.map(col => col.map(c => ({ ...c }))),
      foundations: foundations.map(f => ({ suit: f.suit, cards: f.cards.map(c => ({ ...c })) })),
      moves,
    });
    if (history.length > 64) history.shift();
  }

  function undo() {
    if (!history.length) return;
    const prev  = history.pop();
    tableau     = prev.tableau;
    foundations = prev.foundations;
    moves       = prev.moves;
    drag        = null;
    won         = false;
    updateMoveCounter();
    hideWin();
    render();
  }

  // ── Move logic ───────────────────────────────────────────────────────────────
  function topCard(col) {
    return col.length ? col[col.length - 1] : null;
  }

  function canPlaceOnTableau(card, targetCol) {
    const top = topCard(targetCol);
    if (!top) return true;
    return RANK_VALUES[card.rank] === RANK_VALUES[top.rank] - 1;
  }

  function canPlaceOnFoundation(card, foundation) {
    if (foundation.cards.length === 0) return card.rank === 'A' && card.suit === foundation.suit;
    const top = foundation.cards[foundation.cards.length - 1];
    return card.suit === foundation.suit && RANK_VALUES[card.rank] === RANK_VALUES[top.rank] + 1;
  }

  function autoFoundation(card, sourceCol) {
    for (const f of foundations) {
      if (canPlaceOnFoundation(card, f)) {
        snapshot();
        sourceCol.pop();
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

  function moveCard(fromColIdx, toColIdx) {
    const fromCol = tableau[fromColIdx];
    const toCol   = tableau[toColIdx];
    const card    = topCard(fromCol);
    if (!card) return false;
    if (!canPlaceOnTableau(card, toCol)) return false;
    snapshot();
    fromCol.pop();
    toCol.push(card);
    moves++;
    updateMoveCounter();
    render();
    return true;
  }

  function moveToFoundation(fromColIdx) {
    const fromCol = tableau[fromColIdx];
    const card    = topCard(fromCol);
    if (!card) return false;
    return autoFoundation(card, fromCol);
  }

  // ── Hit testing ──────────────────────────────────────────────────────────────
  function canvasPos(e) {
    // Return CSS-pixel coordinates. All layout vars are in CSS pixels.
    // The DPR scaling is handled by ctx.setTransform() in render(), not here.
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function hitTestColumn(x, y) {
    for (let c = 0; c < NUM_COLS; c++) {
      const col    = tableau[c];
      const cx     = COL_X[c];
      const rowTop = ROW_Y[COL_ROW[c]] || TABLEAU_TOP;

      if (x < cx || x > cx + CW) continue;

      if (col.length === 0) {
        if (y >= rowTop && y <= rowTop + CH) {
          return { colIndex: c, cardIndex: -1 };
        }
        continue;
      }

      const topY = cardY(c, 0);
      const botY = cardY(c, col.length - 1) + CH;
      if (y >= topY && y <= botY) {
        return { colIndex: c, cardIndex: col.length - 1 };
      }
    }
    return null;
  }

  function hitTestFoundation(x, y) {
    for (let i = 0; i < NUM_FOUND; i++) {
      const fx = FOUND_X[i];
      if (x >= fx && x <= fx + CW && y >= FOUND_Y && y <= FOUND_Y + CH) {
        return i;
      }
    }
    return -1;
  }

  // ── Pointer / drag events ────────────────────────────────────────────────────
  canvas.addEventListener('pointerdown', function (e) {
    if (won || paused) return;
    const { x, y } = canvasPos(e);

    const hit = hitTestColumn(x, y);
    if (!hit || hit.cardIndex === -1) return;  // empty column or miss — allow page scroll

    const col  = tableau[hit.colIndex];
    const card = topCard(col);
    if (!card) return;

    // Only lock scrolling once we know a card drag is actually starting
    e.preventDefault();
    const cardX   = COL_X[hit.colIndex];
    const cardYPos = cardY(hit.colIndex, col.length - 1);

    canvas.setPointerCapture(e.pointerId);
    drag = {
      colIndex: hit.colIndex,
      card,
      x,
      y,
      offsetX: x - cardX,
      offsetY: y - cardYPos,
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
    const { x, y } = canvasPos(e);
    const d = drag;
    drag = null;

    // Try foundation drop
    const foundIdx = hitTestFoundation(x, y);
    if (foundIdx >= 0) {
      const fromCol = tableau[d.colIndex];
      const card    = topCard(fromCol);
      if (card && canPlaceOnFoundation(card, foundations[foundIdx])) {
        snapshot();
        fromCol.pop();
        foundations[foundIdx].cards.push(card);
        moves++;
        updateMoveCounter();
        checkWin();
      }
      render();
      return;
    }

    // Try column drop
    const hit = hitTestColumn(x, y);
    if (hit && hit.colIndex !== d.colIndex) {
      moveCard(d.colIndex, hit.colIndex);
      return;
    }

    render();  // snap back — card returns to source column
  });

  canvas.addEventListener('pointercancel', function () {
    drag = null;
    render();
  });

  // Double-click: auto-send top card to foundation
  canvas.addEventListener('dblclick', function (e) {
    if (won || paused) return;
    drag = null;
    const { x, y } = canvasPos(e);
    const hit = hitTestColumn(x, y);
    if (hit && hit.cardIndex !== -1) {
      moveToFoundation(hit.colIndex);
    }
  });

  // ── Rendering ────────────────────────────────────────────────────────────────
  function cardY(colIdx, cardIdx) {
    const overlap = Math.round(CH * effectiveOverlap);
    return (ROW_Y[COL_ROW[colIdx]] || TABLEAU_TOP) + cardIdx * overlap;
  }

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
    // Work in CSS pixels — setTransform scales all drawing to device pixels.
    const dpr = window.devicePixelRatio || 1;
    const W   = canvas.width  / dpr;
    const H   = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#1b5e20';
    ctx.fillRect(0, 0, W, H);

    // Precompute valid drop targets while dragging
    const validCols  = new Set();
    const validFound = new Set();
    if (drag) {
      for (let c = 0; c < NUM_COLS; c++) {
        if (c !== drag.colIndex && canPlaceOnTableau(drag.card, tableau[c])) {
          validCols.add(c);
        }
      }
      for (let i = 0; i < NUM_FOUND; i++) {
        if (canPlaceOnFoundation(drag.card, foundations[i])) {
          validFound.add(i);
        }
      }
    }

    // Draw foundations
    for (let i = 0; i < NUM_FOUND; i++) {
      const fx = FOUND_X[i];
      const f  = foundations[i];
      if (f.cards.length === 0) {
        drawEmptySlot(ctx, fx, FOUND_Y, CW, CH);
        ctx.save();
        ctx.font         = `${Math.round(CH * 0.35)}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha  = 0.35;
        ctx.fillStyle    = SUIT_COLORS[f.suit];
        ctx.fillText(SUIT_SYMBOLS[f.suit], fx + CW / 2, FOUND_Y + CH / 2);
        ctx.restore();
      } else {
        drawCard(ctx, f.cards[f.cards.length - 1], fx, FOUND_Y, CW, CH);
      }
      if (showHints && validFound.has(i)) drawDropHighlight(fx, FOUND_Y, CW, CH);
    }

    // Foundation label — desktop only (no room on mobile)
    if (NUM_ROWS === 1) {
      ctx.save();
      ctx.font         = `${Math.round(CW * 0.18)}px sans-serif`;
      ctx.fillStyle    = 'rgba(255,255,255,0.35)';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('FOUNDATIONS', FOUND_X[NUM_FOUND - 1] + CW, FOUND_Y - 4);
      ctx.restore();
    }

    // Draw tableau columns
    for (let c = 0; c < NUM_COLS; c++) {
      const col = tableau[c];
      const cx  = COL_X[c];

      if (col.length === 0) {
        const rowTop = ROW_Y[COL_ROW[c]] || TABLEAU_TOP;
        drawEmptySlot(ctx, cx, rowTop, CW, CH);
        if (showHints && drag && validCols.has(c)) drawDropHighlight(cx, rowTop, CW, CH);
        continue;
      }

      for (let k = 0; k < col.length; k++) {
        const card  = col[k];
        const isTop = k === col.length - 1;
        const cy    = cardY(c, k);

        if (drag && drag.colIndex === c && isTop) {
          // Ghost outline at the card's origin while it's being dragged
          ctx.save();
          ctx.globalAlpha = 0.25;
          drawCard(ctx, card, cx, cy, CW, CH);
          ctx.restore();
          continue;
        }

        ctx.save();
        if (!isTop) ctx.globalAlpha = 0.5;  // non-top cards are dimmed
        drawCard(ctx, card, cx, cy, CW, CH);
        ctx.restore();
      }

      // Drop highlight on top card of valid target columns
      if (showHints && drag && validCols.has(c)) {
        drawDropHighlight(cx, cardY(c, col.length - 1), CW, CH);
      }
    }

    // Draw dragged card floating above everything else
    if (drag) {
      const dx = drag.x - drag.offsetX;
      const dy = drag.y - drag.offsetY;
      ctx.save();
      ctx.shadowColor   = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur    = 8;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 4;
      drawCard(ctx, drag.card, dx, dy, CW, CH);
      ctx.restore();
    }

    // Pause overlay — drawn last so it sits above everything
    if (paused) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(0, 0, W, H);
      ctx.font         = `bold ${Math.round(CH * 0.55)}px Arial, system-ui, sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#1a1a1a';
      ctx.fillText('PAUSED', W / 2, H / 2);
      ctx.font         = `${Math.round(CH * 0.22)}px Arial, system-ui, sans-serif`;
      ctx.fillStyle    = '#555555';
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

  // ── Timer ────────────────────────────────────────────────────────────────────
  function startTimer() {
    startTime = Date.now();
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      updateTimer(elapsed);
    }, 1000);
  }

  function updateTimer(seconds) {
    document.getElementById('timer').textContent = formatTime(seconds);
  }

  function formatTime(s) {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  function updateMoveCounter() {
    document.getElementById('moveCount').textContent = moves;
  }

  // ── Pause / hints toggles ────────────────────────────────────────────────────
  function togglePause() {
    if (won) return;
    const btn = document.getElementById('btnPause');
    if (!paused) {
      // Pause
      clearInterval(timerInterval);
      pausedAt = Date.now();
      paused   = true;
      drag     = null;
      btn.textContent = 'Resume';
    } else {
      // Resume — offset startTime by the duration we were paused
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

  // ── Button wiring ────────────────────────────────────────────────────────────
  document.getElementById('btnNew').addEventListener('click', newGame);
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnPause').addEventListener('click', togglePause);
  document.getElementById('btnHints').addEventListener('click', toggleHints);
  document.getElementById('winNewGame').addEventListener('click', newGame);

  // ── Responsive resize ────────────────────────────────────────────────────────
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 120);
  });

  // ── Boot ────────────────────────────────────────────────────────────────────
  resize();
  newGame();

}());
