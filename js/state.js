/* =========================================================================
 * Aura Invest · Estado de la aplicación
 * Un único objeto mutable compartido por gráficos, panel y controles.
 * ========================================================================= */
(() => {
'use strict';

Aura.state = {
  symbol: 'AAPL',
  tf: '6M',
  page: 'market',    // vista visible: 'market' (gráficos) | 'portfolio' (cartera)
  show: { ema: true, sma: true, sr: true, cone: true, bb: false, macd: false },
  compare: [],       // valores superpuestos en el modo Comparar (máx. 4; dura la sesión)
  model: null,       // resultado de Aura.model.analyze() para el ticker/temporalidad actual
  view: null,        // { data, quote } de la última carga correcta (barra de estado)
  quotes: new Map(), // última cotización conocida por símbolo (la watchlist vive en Aura.watchlist)
  queue: null,       // estado de la cola de la API (créditos, esperas)
  reqId: 0,          // descarta respuestas obsoletas al cambiar rápido de vista
  coneClamp: null,   // límites de autoescala del cono
};
})();
