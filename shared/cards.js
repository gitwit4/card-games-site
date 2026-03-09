// shared/cards.js — Reusable card deck logic for all games

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUES = { A: 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, J: 11, Q: 12, K: 13 };

const SUIT_SYMBOLS = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const SUIT_COLORS  = { hearts: '#d40000', diamonds: '#d40000', clubs: '#1a1a1a', spades: '#1a1a1a' };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank], faceUp: false });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardLabel(card) {
  return `${card.rank}${SUIT_SYMBOLS[card.suit]}`;
}

function isRed(card) {
  return card.suit === 'hearts' || card.suit === 'diamonds';
}

function isBlack(card) {
  return card.suit === 'clubs' || card.suit === 'spades';
}

// Draw a single playing card on a canvas context
// x, y = top-left corner; w, h = dimensions
function drawCard(ctx, card, x, y, w, h, options = {}) {
  const { selected = false, shadow = true } = options;
  const radius = Math.max(4, w * 0.06);

  ctx.save();

  // Shadow
  if (shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 2;
    ctx.shadowOffsetY = 2;
  }

  // Card body
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = selected ? '#fffde7' : '#ffffff';
  ctx.fill();

  // Border — highlight if selected
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = selected ? '#f9a825' : '#c8c8c8';
  ctx.lineWidth = selected ? 2.5 : 1;
  ctx.stroke();

  ctx.restore();

  if (!card.faceUp) {
    drawCardBack(ctx, x, y, w, h, radius);
    return;
  }

  const color = SUIT_COLORS[card.suit];
  const sym   = SUIT_SYMBOLS[card.suit];
  const cornerFontSize = Math.max(10, w * 0.22);
  const centerFontSize = Math.max(14, w * 0.38);

  ctx.save();
  ctx.fillStyle = color;

  // Top-left rank + suit
  ctx.font = `bold ${cornerFontSize}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(card.rank, x + w * 0.08, y + h * 0.04);

  ctx.font = `${cornerFontSize * 0.85}px sans-serif`;
  ctx.fillText(sym, x + w * 0.08, y + h * 0.04 + cornerFontSize * 1.1);

  // Bottom-right (rotated)
  ctx.save();
  ctx.translate(x + w * 0.92, y + h * 0.96);
  ctx.rotate(Math.PI);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `bold ${cornerFontSize}px sans-serif`;
  ctx.fillText(card.rank, 0, 0);
  ctx.font = `${cornerFontSize * 0.85}px sans-serif`;
  ctx.fillText(sym, 0, cornerFontSize * 1.1);
  ctx.restore();

  // Center symbol
  ctx.font = `${centerFontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(sym, x + w / 2, y + h / 2);

  ctx.restore();
}

function drawCardBack(ctx, x, y, w, h, radius) {
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, x + 3, y + 3, w - 6, h - 6, radius * 0.7);
  ctx.fillStyle = '#1565c0';
  ctx.fill();

  // Simple cross-hatch pattern
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 0.5;
  const step = 6;
  ctx.beginPath();
  for (let i = x + 3; i < x + w - 3; i += step) {
    ctx.moveTo(i, y + 3);
    ctx.lineTo(i, y + h - 3);
  }
  for (let j = y + 3; j < y + h - 3; j += step) {
    ctx.moveTo(x + 3, j);
    ctx.lineTo(x + w - 3, j);
  }
  ctx.stroke();
  ctx.restore();
}

// Draw an empty pile slot
function drawEmptySlot(ctx, x, y, w, h) {
  const radius = Math.max(4, w * 0.06);
  ctx.save();
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, radius);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Polyfill for roundRect path
function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
