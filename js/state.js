/* =========================================================================
 * Aura Invest · Estado de la aplicación
 * Un único objeto mutable compartido por gráficos, panel y controles.
 * ========================================================================= */
(() => {
'use strict';

Aura.state = {
  symbol: 'AAPL',
  tf: '6M',
  // Watchlist fija de la Fase 1 (en la Fase 2 será editable y se guardará).
  // SAN:BME se mantiene para comprobar el aviso de mercado fuera del plan gratuito.
  watchlist: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'SAN:BME'],
  show: { ema: true, sma: true, sr: true, cone: true },
  model: null,       // resultado de Aura.model.analyze() para el ticker/temporalidad actual
  view: null,        // { data, quote } de la última carga correcta (barra de estado)
  quotes: new Map(), // última cotización conocida por símbolo (watchlist)
  queue: null,       // estado de la cola de la API (créditos, esperas)
  reqId: 0,          // descarta respuestas obsoletas al cambiar rápido de vista
  coneClamp: null,   // límites de autoescala del cono
};
})();
