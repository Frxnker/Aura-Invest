/* =========================================================================
 * Aura Invest · Primitivas de dibujo
 * Extensiones de Lightweight Charts (API de primitivas de serie, v4.1+).
 * ========================================================================= */
(() => {
'use strict';

const { last } = Aura.utils;

/**
 * Primitiva de serie que rellena el área entre una banda superior y otra inferior
 * (cono de previsión o Bandas de Bollinger). Se dibuja por debajo de las series.
 * Sin `fill`, usa el degradado morado del cono; con `fill`, un color sólido.
 */
class ConeFillPrimitive {
  constructor({ fill = null } = {}) {
    this.fill = fill;
    this.points = [];
    this.coords = [];
    const self = this;
    this.paneView = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw(target) {
          const c = self.coords;
          if (c.length < 2) return;
          target.useMediaCoordinateSpace(({ context: ctx }) => {
            ctx.save();
            ctx.beginPath();
            c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.yU) : ctx.moveTo(p.x, p.yU)));
            for (let i = c.length - 1; i >= 0; i--) ctx.lineTo(c[i].x, c[i].yL);
            ctx.closePath();
            if (self.fill) {
              ctx.fillStyle = self.fill;
            } else {
              const g = ctx.createLinearGradient(c[0].x, 0, last(c).x + 1, 0);
              g.addColorStop(0, 'rgba(139,108,240,0.30)');
              g.addColorStop(1, 'rgba(139,108,240,0.07)');
              ctx.fillStyle = g;
            }
            ctx.fill();
            ctx.restore();
          });
        },
      }),
    };
  }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = this.series = this.requestUpdate = null; }
  setPoints(points) { this.points = points; this.requestUpdate && this.requestUpdate(); }
  updateAllViews() {
    if (!this.chart || !this.series) { this.coords = []; return; }
    const ts = this.chart.timeScale();
    this.coords = this.points
      .map((p) => ({ x: ts.timeToCoordinate(p.time), yU: this.series.priceToCoordinate(p.upper), yL: this.series.priceToCoordinate(p.lower) }))
      .filter((p) => p.x !== null && p.yU !== null && p.yL !== null);
  }
  paneViews() { return [this.paneView]; }
}

/** Primitiva que sombrea una franja horizontal fija (zona 30–70 del RSI). */
class HorizontalBandPrimitive {
  constructor(lo, hi, color) {
    this.lo = lo; this.hi = hi; this.color = color; this.y = null;
    const self = this;
    this.paneView = {
      zOrder: () => 'bottom',
      renderer: () => ({
        draw(target) {
          if (!self.y) return;
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            ctx.fillStyle = self.color;
            ctx.fillRect(0, self.y[0], mediaSize.width, self.y[1] - self.y[0]);
          });
        },
      }),
    };
  }
  attached({ series }) { this.series = series; }
  detached() { this.series = null; }
  updateAllViews() {
    if (!this.series) { this.y = null; return; }
    const a = this.series.priceToCoordinate(this.hi), b = this.series.priceToCoordinate(this.lo);
    this.y = a === null || b === null ? null : [a, b];
  }
  paneViews() { return [this.paneView]; }
}

/**
 * Dibujos del usuario sobre el gráfico de precio: líneas horizontales (de lado a
 * lado, con su precio a la derecha) y de tendencia (segmento entre dos puntos).
 * La posición horizontal de cada punto la resuelve `resolveX(t)` (fecha → píxel),
 * porque los puntos no tienen por qué coincidir con una vela de la temporalidad.
 * Expone `coords` (píxeles) para detectar qué dibujo hay bajo el puntero.
 */
class DrawingsPrimitive {
  constructor() {
    this.items = []; this.coords = []; this.previewCoords = null;
    this.selectedId = null; this.preview = null;
    this.resolveX = () => null; this.format = (p) => String(p);
    const self = this;
    this.paneView = {
      zOrder: () => 'top',
      renderer: () => ({ draw(target) { target.useMediaCoordinateSpace(({ context, mediaSize }) => self.paint(context, mediaSize.width)); } }),
    };
  }
  attached({ series, requestUpdate }) { this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.series = this.requestUpdate = null; }
  set(o) { Object.assign(this, o); if (this.requestUpdate) this.requestUpdate(); }
  toCoords(d) {
    const y = (p) => this.series.priceToCoordinate(p);
    if (d.kind === 'hline') { const c = { id: d.id, kind: 'hline', y: y(d.price), price: d.price }; return c.y == null ? null : c; }
    const c = { id: d.id, kind: 'trend', xa: this.resolveX(d.a.t), ya: y(d.a.p), xb: this.resolveX(d.b.t), yb: y(d.b.p) };
    return [c.xa, c.ya, c.xb, c.yb].every((v) => v != null && Number.isFinite(v)) ? c : null;
  }
  updateAllViews() {
    if (!this.series) { this.coords = []; this.previewCoords = null; return; }
    this.coords = this.items.map((d) => this.toCoords(d)).filter(Boolean);
    this.previewCoords = this.preview ? this.toCoords({ id: 'preview', ...this.preview }) : null;
  }
  paint(ctx, width) {
    ctx.save();
    ctx.font = "11px 'JetBrains Mono', ui-monospace, monospace";
    const line = (c, color, w, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash || []);
      ctx.beginPath();
      if (c.kind === 'hline') { ctx.moveTo(0, c.y); ctx.lineTo(width, c.y); } else { ctx.moveTo(c.xa, c.ya); ctx.lineTo(c.xb, c.yb); }
      ctx.stroke();
    };
    for (const c of this.coords) {
      const sel = c.id === this.selectedId;
      line(c, sel ? '#b9a8ff' : 'rgba(231,233,240,0.85)', sel ? 2.5 : 1.5);
      if (c.kind === 'hline') {
        const text = this.format(c.price);
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = sel ? '#b9a8ff' : 'rgba(231,233,240,0.92)';
        ctx.fillRect(width - w - 4, c.y - 9, w, 18);
        ctx.fillStyle = '#0b0d13';
        ctx.fillText(text, width - w + 1, c.y + 4);
      } else if (sel) {
        ctx.fillStyle = '#b9a8ff';
        for (const [x, y] of [[c.xa, c.ya], [c.xb, c.yb]]) { ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); }
      }
    }
    if (this.previewCoords) line(this.previewCoords, '#b9a8ff', 1.5, [6, 4]);
    ctx.restore();
  }
  paneViews() { return [this.paneView]; }
}

Aura.primitives = { ConeFillPrimitive, HorizontalBandPrimitive, DrawingsPrimitive };
})();
