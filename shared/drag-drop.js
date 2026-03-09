// shared/drag-drop.js — Reusable pointer-event drag helpers for canvas games
// Each game initialises a DragController and provides its own hit-test callbacks.

class DragController {
  constructor(canvas, callbacks) {
    // callbacks: { onPickUp, onDrop, onMove, onRender }
    this.canvas    = canvas;
    this.cb        = callbacks;
    this.dragging  = false;
    this.payload   = null;   // whatever onPickUp returns
    this.startX    = 0;
    this.startY    = 0;
    this.currentX  = 0;
    this.currentY  = 0;
    this.offsetX   = 0;      // cursor offset within the picked-up card
    this.offsetY   = 0;

    this._bind();
  }

  _bind() {
    const el = this.canvas;
    el.addEventListener('pointerdown',  this._onDown.bind(this));
    el.addEventListener('pointermove',  this._onMove.bind(this));
    el.addEventListener('pointerup',    this._onUp.bind(this));
    el.addEventListener('pointercancel',this._onUp.bind(this));
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / r.width;
    const scaleY = this.canvas.height / r.height;
    return {
      x: (e.clientX - r.left) * scaleX,
      y: (e.clientY - r.top)  * scaleY,
    };
  }

  _onDown(e) {
    e.preventDefault();
    const { x, y } = this._pos(e);
    const result = this.cb.onPickUp?.(x, y);
    if (!result) return;

    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.payload  = result;
    this.startX   = x;
    this.startY   = y;
    this.currentX = x;
    this.currentY = y;
    this.offsetX  = result.offsetX ?? 0;
    this.offsetY  = result.offsetY ?? 0;
    this.cb.onRender?.();
  }

  _onMove(e) {
    if (!this.dragging) return;
    e.preventDefault();
    const { x, y } = this._pos(e);
    this.currentX = x;
    this.currentY = y;
    this.cb.onMove?.(x, y, this.payload);
    this.cb.onRender?.();
  }

  _onUp(e) {
    if (!this.dragging) return;
    const { x, y } = this._pos(e);
    this.dragging = false;
    this.cb.onDrop?.(x, y, this.payload);
    this.payload  = null;
    this.cb.onRender?.();
  }

  // Current drag position (card top-left)
  get dragX() { return this.currentX - this.offsetX; }
  get dragY() { return this.currentY - this.offsetY; }
}
