// freecell/game.js — FreeCell Solitaire

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────────────
  const NUM_COLS = 8;
  const NUM_FREE = 4;
  const NUM_FOUND = 4;

  // ── State ────────────────────────────────────────────────────────────────────
  let freeCells   = [null, null, null, null];
  let foundations = [];   // [{ suit, cards: [] }, ...]
  let tableau     = [];   // 8 arrays of cards (all face-up)
  let drag        = null; // { source, cellIdx?, colIdx?, fromCardIdx?, cards[], x, y, offsetX, offsetY }
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
  let COL_X         = [];  // x positions for 8 columns
  let TOP_Y;               // y of free cells / foundations row
  let TABLEAU_TOP;         // y where tableau columns start
  let OVERLAP;             // px of each card shown in a stack

  // ── Canvas ───────────────────────────────────────────────────────────────────
  const canvas = document.getElementById('gameCanvas');
  const ctx    = canvas.getContext('2d');

  function resize() {
    const wrapper  = canvas.parentElement;
    const W        = wrapper.clientWidth || 800;
    const isMobile = W <= 680;

    MARGIN_X = Math.round(W * (isMobile ? 0.006 : 0.01));
    CW       = Math.floor((W - MARGIN_X * (NUM_COLS + 1)) / NUM_COLS);

    if (isMobile) {
      CW = Math.floor(CW * 0.94);
      const wrapH = wrapper.clientHeight;
      if (wrapH > 100) CW = Math.min(CW, Math.floor(wrapH / 8));
    }

    CH       = Math.round(CW * (3.5 / 2.5));
    MARGIN_Y = Math.round(CH * 0.12);

    const colStep = (W - MARGIN_X * 2) / NUM_COLS;
    COL_X = Array.from({ length: NUM_COLS }, (_, i) => Math.round(MARGIN_X + i * colStep));

    TOP_Y       = MARGIN_Y;
    TABLEAU_TOP = TOP_Y + CH + MARGIN_Y * 2;

    OVERLAP = Math.round(CH * 0.28);

    // On mobile, compress overlap to fit columns in the available height
    if (isMobile) {
      const wrapH = wrapper.clientHeight;
      if (wrapH > 100) {
        const available = wrapH - TABLEAU_TOP - CH - MARGIN_Y;
        if (available > 0) OVERLAP = Math.min(OVERLAP, Math.floor(available / 13));
      }
    }

    const dpr = window.devicePixelRatio || 1;
    let logicalH;
    if (isMobile && wrapper.clientHeight > 100) {
      logicalH = wrapper.clientHeight;
    } else {
      logicalH = TABLEAU_TOP + 13 * OVERLAP + CH + MARGIN_Y;
    }

    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(logicalH * dpr);

    render();
  }

  // ── Card y-position in a tableau column ──────────────────────────────────────
  // All FreeCell cards are face-up so a fixed OVERLAP per card is correct.
  function colCardY(cardIdx) {
    return TABLEAU_TOP + cardIdx * OVERLAP;
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
    deck.forEach(c => { c.faceUp = true; });

    // 8 columns: first 4 get 7 cards, last 4 get 6 cards
    tableau = [];
    let idx = 0;
    for (let c = 0; c < NUM_COLS; c++) {
      const count = c < 4 ? 7 : 6;
      tableau.push(deck.slice(idx, idx + count));
      idx += count;
    }

    freeCells   = [null, null, null, null];
    foundations = SUITS.map(suit => ({ suit, cards: [] }));

    startTimer();
    render();
    hideWin();
  }

  // ── Snapshot / Undo ──────────────────────────────────────────────────────────
  function snapshot() {
    history.push({
      freeCells:   freeCells.map(c => c ? { ...c } : null),
      foundations: foundations.map(f => ({ suit: f.suit, cards: f.cards.map(c => ({ ...c })) })),
      tableau:     tableau.map(col => col.map(c => ({ ...c }))),
      moves,
    });
    if (history.length > 64) history.shift();
  }

  function undo() {
    if (!history.length) return;
    const prev  = history.pop();
    freeCells   = prev.freeCells;
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

  // FreeCell tableau: any card on empty column; otherwise one lower and opposite color.
  function canPlaceOnTableau(card, targetCol) {
    if (targetCol.length === 0) return true;
    const top = topCard(targetCol);
    return card.value === top.value - 1 && isRed(card) !== isRed(top);
  }

  function canPlaceOnFoundation(card, foundation) {
    if (!card.faceUp) return false;
    if (foundation.cards.length === 0) return card.rank === 'A' && card.suit === foundation.suit;
    const top = foundation.cards[foundation.cards.length - 1];
    return card.suit === foundation.suit && card.value === top.value + 1;
  }

  // A valid FreeCell sequence: cards descend by one and alternate color.
  function isValidSequence(cards) {
    if (!cards.length) return false;
    for (let i = 0; i < cards.length - 1; i++) {
      const a = cards[i], b = cards[i + 1];
      if (b.value !== a.value - 1 || isRed(a) === isRed(b)) return false;
    }
    return true;
  }

  // Supermove: max cards movable = (empty free cells + 1) × 2^(empty columns).
  // If the target itself is an empty column, subtract 1 from the empty column count.
  function maxMovable(targetIsEmpty) {
    const emptyCells = freeCells.filter(c => c === null).length;
    const emptyCols  = tableau.filter(col => col.length === 0).length;
    const usable     = targetIsEmpty ? Math.max(0, emptyCols - 1) : emptyCols;
    return (emptyCells + 1) * Math.pow(2, usable);
  }

  // ── Source helpers ────────────────────────────────────────────────────────────
  function removeFromSource(d) {
    if (d.source === 'freecell') {
      freeCells[d.cellIdx] = null;
    } else {
      tableau[d.colIdx].splice(d.fromCardIdx);
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
  function hitTestTableau(x, y) {
    for (let c = 0; c < NUM_COLS; c++) {
      if (x < COL_X[c] || x > COL_X[c] + CW) continue;
      const col = tableau[c];

      if (col.length === 0) {
        if (y >= TABLEAU_TOP && y <= TABLEAU_TOP + CH) return { colIdx: c, fromCardIdx: -1 };
        continue;
      }

      // Iterate from top card downward — highest index is on top visually
      for (let k = col.length - 1; k >= 0; k--) {
        if (y >= colCardY(k) && y <= colCardY(k) + CH) return { colIdx: c, fromCardIdx: k };
      }
    }
    return null;
  }

  // ── Pointer events ────────────────────────────────────────────────────────────
  canvas.addEventListener('pointerdown', function (e) {
    if (won || paused) return;
    const { x, y } = canvasPos(e);

    // ── Top row: free cells ──
    if (y >= TOP_Y && y <= TOP_Y + CH) {
      for (let i = 0; i < NUM_FREE; i++) {
        if (x >= COL_X[i] && x <= COL_X[i] + CW && freeCells[i] !== null) {
          e.preventDefault();
          canvas.setPointerCapture(e.pointerId);
          drag = {
            source:  'freecell',
            cellIdx: i,
            cards:   [freeCells[i]],
            x, y,
            offsetX: x - COL_X[i],
            offsetY: y - TOP_Y,
          };
          render();
          return;
        }
      }
      return; // clicked foundation or gap — no drag
    }

    // ── Tableau ──
    const hit = hitTestTableau(x, y);
    if (!hit || hit.fromCardIdx === -1) return; // empty slot or miss

    const col       = tableau[hit.colIdx];
    const dragCards = col.slice(hit.fromCardIdx);
    if (!isValidSequence(dragCards)) return; // broken sequence

    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    drag = {
      source:      'tableau',
      colIdx:       hit.colIdx,
      fromCardIdx:  hit.fromCardIdx,
      cards:        dragCards,
      x, y,
      offsetX: x - COL_X[hit.colIdx],
      offsetY: y - colCardY(hit.fromCardIdx),
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

    const dragLeft = d.x - d.offsetX;
    const dragTop  = d.y - d.offsetY;
    const dragCX   = dragLeft + CW / 2;
    const dragCY   = dragTop  + CH / 2;

    // ── Single-card drops: foundation or free cell ──
    if (d.cards.length === 1 && dragCY >= TOP_Y - CH * 0.6 && dragCY <= TOP_Y + CH * 1.6) {

      // Foundation drop (columns 4–7)
      for (let i = 0; i < NUM_FOUND; i++) {
        if (Math.abs(dragCX - (COL_X[4 + i] + CW / 2)) < CW * 0.55) {
          if (canPlaceOnFoundation(card, foundations[i])) {
            snapshot();
            removeFromSource(d);
            foundations[i].cards.push(card);
            moves++;
            updateMoveCounter();
            checkWin();
            render();
            return;
          }
          break;
        }
      }

      // Free cell drop (columns 0–3)
      for (let i = 0; i < NUM_FREE; i++) {
        if (Math.abs(dragCX - (COL_X[i] + CW / 2)) < CW * 0.55 && freeCells[i] === null) {
          snapshot();
          removeFromSource(d);
          freeCells[i] = card;
          moves++;
          updateMoveCounter();
          render();
          return;
        }
      }
    }

    // ── Tableau drop: find closest column by center x ──
    let targetC = -1, bestDist = CW * 0.6;
    for (let c = 0; c < NUM_COLS; c++) {
      const dist = Math.abs(dragCX - (COL_X[c] + CW / 2));
      if (dist < bestDist) { bestDist = dist; targetC = c; }
    }

    if (targetC >= 0 && (d.source !== 'tableau' || targetC !== d.colIdx)) {
      if (canPlaceOnTableau(card, tableau[targetC])) {
        const targetEmpty = tableau[targetC].length === 0;
        if (d.cards.length <= maxMovable(targetEmpty)) {
          snapshot();
          removeFromSource(d);
          tableau[targetC].push(...d.cards);
          moves++;
          updateMoveCounter();
          render();
          return;
        }
      }
    }

    render(); // invalid drop — snap back
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

    // Free cell
    if (y >= TOP_Y && y <= TOP_Y + CH) {
      for (let i = 0; i < NUM_FREE; i++) {
        if (x >= COL_X[i] && x <= COL_X[i] + CW && freeCells[i] !== null) {
          tryAutoFoundation(freeCells[i], () => { freeCells[i] = null; });
          return;
        }
      }
    }

    // Tableau top card
    const hit = hitTestTableau(x, y);
    if (hit && hit.fromCardIdx !== -1) {
      const col = tableau[hit.colIdx];
      if (hit.fromCardIdx === col.length - 1) {
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
    const validFree     = new Set();
    if (drag && showHints) {
      const card = drag.cards[0];
      for (let c = 0; c < NUM_COLS; c++) {
        if (drag.source === 'tableau' && c === drag.colIdx) continue;
        if (canPlaceOnTableau(card, tableau[c])) {
          const targetEmpty = tableau[c].length === 0;
          if (drag.cards.length <= maxMovable(targetEmpty)) validTabCols.add(c);
        }
      }
      if (drag.cards.length === 1) {
        for (let i = 0; i < NUM_FOUND; i++) {
          if (canPlaceOnFoundation(card, foundations[i])) validFoundIdx.add(i);
        }
        for (let i = 0; i < NUM_FREE; i++) {
          if (freeCells[i] === null) validFree.add(i);
        }
      }
    }

    // ── Free cells (columns 0–3 of top row) ──
    for (let i = 0; i < NUM_FREE; i++) {
      const fx = COL_X[i];
      const c  = freeCells[i];
      const isGhost = drag && drag.source === 'freecell' && drag.cellIdx === i;

      if (c === null) {
        drawEmptySlot(ctx, fx, TOP_Y, CW, CH);
        // "FREE" label
        ctx.save();
        ctx.font         = `bold ${Math.round(CW * 0.16)}px sans-serif`;
        ctx.fillStyle    = 'rgba(255,255,255,0.28)';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('FREE', fx + CW / 2, TOP_Y + CH / 2);
        ctx.restore();
      } else if (isGhost) {
        ctx.save(); ctx.globalAlpha = 0.22;
        drawCard(ctx, c, fx, TOP_Y, CW, CH);
        ctx.restore();
      } else {
        drawCard(ctx, c, fx, TOP_Y, CW, CH);
      }

      if (showHints && validFree.has(i)) drawDropHighlight(fx, TOP_Y, CW, CH);
    }

    // ── Foundations (columns 4–7 of top row) ──
    for (let i = 0; i < NUM_FOUND; i++) {
      const fx = COL_X[4 + i];
      const f  = foundations[i];

      if (f.cards.length === 0) {
        drawEmptySlot(ctx, fx, TOP_Y, CW, CH);
        ctx.save();
        ctx.font         = `${Math.round(CH * 0.35)}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha  = 0.35;
        ctx.fillStyle    = SUIT_COLORS[f.suit];
        ctx.fillText(SUIT_SYMBOLS[f.suit], fx + CW / 2, TOP_Y + CH / 2);
        ctx.restore();
      } else {
        drawCard(ctx, f.cards[f.cards.length - 1], fx, TOP_Y, CW, CH);
      }

      if (showHints && validFoundIdx.has(i)) drawDropHighlight(fx, TOP_Y, CW, CH);
    }

    // ── Tableau ──
    for (let c = 0; c < NUM_COLS; c++) {
      const col = tableau[c];
      const cx  = COL_X[c];

      if (col.length === 0) {
        drawEmptySlot(ctx, cx, TABLEAU_TOP, CW, CH);
        if (showHints && validTabCols.has(c)) drawDropHighlight(cx, TABLEAU_TOP, CW, CH);
        continue;
      }

      for (let k = 0; k < col.length; k++) {
        const card      = col[k];
        const cy        = colCardY(k);
        const isDragged = drag && drag.source === 'tableau' &&
                          drag.colIdx === c && k >= drag.fromCardIdx;

        if (isDragged) {
          if (k === drag.fromCardIdx) {
            ctx.save(); ctx.globalAlpha = 0.22;
            drawCard(ctx, card, cx, cy, CW, CH);
            ctx.restore();
          }
          continue;
        }

        drawCard(ctx, card, cx, cy, CW, CH);
      }

      // Drop highlight on top card
      if (showHints && validTabCols.has(c)) {
        drawDropHighlight(cx, colCardY(col.length - 1), CW, CH);
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
        drawCard(ctx, drag.cards[i], dx, dy + i * OVERLAP, CW, CH);
      }
      ctx.restore();
    }

    // ── Pause overlay ──
    if (paused) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(0, 0, W, H);
      ctx.font         = `bold ${Math.round(CH * 0.55)}px Arial, system-ui, sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle    = '#1a1a1a';
      ctx.fillText('PAUSED', W / 2, H / 2);
      ctx.font      = `${Math.round(CH * 0.22)}px Arial, system-ui, sans-serif`;
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
