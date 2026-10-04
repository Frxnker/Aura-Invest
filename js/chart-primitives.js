/* =========================================================================
 * Aura Invest · Primitivas de dibujo
 * Extensiones de Lightweight Charts (API de primitivas de serie, v4.1+).
 * ========================================================================= */
(() => {
'use strict';

const { last } = Aura.utils;

/**
 * Primitiva de serie que rellena el área entre la banda superior e inferior del cono.
 * Se dibuja por debajo de las series (zOrder 'bottom').
 */
class ConeFillPrimitive {
  constructor() {
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
            const g = ctx.createLinearGradient(c[0].x, 0, last(c).x + 1, 0);
            g.addColorStop(0, 'rgba(139,108,240,0.30)');
            g.addColorStop(1, 'rgba(139,108,240,0.07)');
            ctx.fillStyle = g;
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

Aura.primitives = { ConeFillPrimitive, HorizontalBandPrimitive };
})();
