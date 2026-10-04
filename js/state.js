/* =========================================================================
 * Aura Invest · Estado de la aplicación
 * Un único objeto mutable compartido por gráficos, panel y controles.
 * ========================================================================= */
(() => {
'use strict';

Aura.state = {
  symbol: 'AAPL',
  tf: '6M',
  show: { ema: true, sma: true, sr: true, cone: true },
  model: null,       // resultado de Aura.model.analyze() para el ticker/temporalidad actual
  quotes: null,      // última cotización por ticker (watchlist y buscador)
  reqId: 0,          // descarta respuestas obsoletas al cambiar rápido de vista
  coneClamp: null,   // límites de autoescala del cono
};
})();
