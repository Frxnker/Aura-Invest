# Aura Invest

Plataforma web de análisis bursátil con **datos reales de [Twelve Data](https://twelvedata.com/)**:
gráfico de velas con EMA 20, SMA 50, soportes y resistencias, volumen y RSI sincronizados; un
panel «Análisis del modelo» con probabilidad de tendencia, cono de previsión a 3 meses y señal
del modelo (alcista, neutral o bajista); watchlist editable, alertas, cartera, MACD, Bollinger,
comparación de valores, dibujo sobre el gráfico y backtest del modelo.

> Herramienta con fines educativos. Las proyecciones son estimaciones estadísticas y no
> constituyen asesoramiento financiero.

## Cómo abrirla

Es una web estática sin dependencias ni compilación. Sírvela en local:

```sh
node tools/serve.mjs          # http://localhost:8080
```

Necesita conexión para cargar Lightweight Charts, las fuentes y los datos.

### Clave de Twelve Data

La app no inventa precios: sin clave muestra un aviso en lugar de datos.

1. Crea una cuenta gratuita en [twelvedata.com](https://twelvedata.com/pricing) (plan Basic).
2. Copia tu clave desde la sección *API Keys* de tu cuenta.
3. En la app, abre **Ajustes** (icono de engranaje) y pégala.

La clave se guarda solo en ese navegador (`localStorage`, clave `aura:v1`), viaja a Twelve Data
en la cabecera `Authorization` (nunca en una URL) y no está en este repositorio.

**Límites del plan gratuito:** 8 créditos por minuto y 800 al día; cada símbolo de una petición
cuesta 1 crédito. La app pone las peticiones en cola, guarda respuestas en caché según la
temporalidad, agrupa cotizaciones en lotes y muestra el consumo del día. El plan Basic cubre
acciones de EE. UU., forex y cripto; otros mercados (p. ej. la Bolsa de Madrid, BME) requieren
planes de pago y la app lo indica.

## Watchlist y alertas

- **Watchlist**: hasta 12 valores. Se añaden desde el buscador (botón «+» o Alt + Intro sobre un
  resultado) o con la estrella de la cabecera, y se reordenan o quitan en «Editar». Se guarda en
  el navegador. Las cotizaciones se piden en lote.
- **Alertas** por valor: precio ≥ o ≤ un valor, variación del día ≥ X %, cruce EMA 20 / SMA 50,
  RSI 14 > 70 o < 30 y cambio de la señal del modelo a Alcista o Bajista. Se pueden crear, editar,
  pausar, reactivar y borrar (con deshacer); cada una salta una vez y queda en el historial.
- **Cuándo avisan**: al abrir la app y mientras esté abierta. La frecuencia se elige en Ajustes
  (desactivada, o como mucho cada 5, 15 o 30 min; 15 por defecto) y además se reparte el cupo del
  día: si no da para ese ritmo se espacia, con todo cerrado como mucho cada hora, y se reservan
  150 créditos para usar la app. Avisan dentro de la app y, si se activa, con notificaciones del
  navegador.
- **Límites reales**: con la app cerrada no avisan (no hay servidor). Con la pestaña en segundo
  plano el navegador puede ralentizarla o suspenderla (p. ej. las pestañas en suspensión de Edge);
  las comprobaciones se retoman al volver a ella.
- Si la API falla y hay datos anteriores en caché, se muestran **marcados como antiguos**; las
  alertas nunca se evalúan con datos antiguos.

## Cartera

- Operaciones manuales de **compra, venta y dividendo** (fecha, cantidad, precio, comisiones,
  divisa y, opcionalmente, el tipo de cambio que aplicó tu bróker). Se pueden editar y borrar,
  con deshacer. No se puede vender más de lo que se tenía en esa fecha.
- **Coste FIFO** (las primeras acciones compradas son las primeras vendidas, criterio fiscal en
  España); el coste medio se muestra solo como dato informativo.
- Valor actual con cotizaciones reales, ganancia latente y realizada (en la moneda base y en %),
  dividendos, peso de cada posición, reparto y evolución diaria con cierres reales.
- **Moneda base EUR** por defecto. Cada operación se convierte con el cierre EUR/USD (o el par que
  toque) de Twelve Data de su fecha, o con el tipo manual si lo indicas; el valor actual usa la
  cotización actual. La app muestra qué tipo ha usado y de qué fecha es.
- Exportar e importar la cartera en JSON (con validación, vista previa y deshacer) y exportar las
  operaciones en CSV (separador `;`, coma decimal). Las exportaciones nunca incluyen la clave.
- Sin clave de API se ven las operaciones y su coste en la divisa original, sin valor actual.
- Limitación: los *splits* no se ajustan solos; si un valor se divide, corrige las cantidades.

## Más análisis

- **MACD (12, 26, 9)** en su propio panel y **Bandas de Bollinger (20, 2)** sobre el precio, con su
  botón, en la leyenda y en el tooltip. Son solo visuales: no entran en la puntuación del modelo.
- **Comparar**: superpone hasta 4 valores en % desde el inicio de la ventana. Mientras se compara,
  el gráfico usa un único eje en % (se ocultan velas e indicadores en precio).
- **Dibujo**: líneas horizontales y de tendencia, guardadas por valor. Se mueven arrastrando o con
  ↑/↓ y se borran con Supr; el diálogo «Dibujos» permite editarlas y borrarlas con teclado.
- **Backtest del modelo** con velas diarias reales (2, 5 o 10 años; 1 crédito): cada día se ejecuta
  el modelo solo con lo que se sabía ese día y luego se mide el acierto y la rentabilidad de cada
  señal frente a no hacer nada, cuántas veces acabó el precio dentro del cono del 80 % y si se
  tocó antes el objetivo o el stop. Los resultados se muestran tal cual, aunque sean peores que el
  azar.

## Cómo probarla

```sh
node --test "tests/*.test.mjs"
```

Requiere Node con soporte de patrones en `--test` (Node 21 o posterior; probado con Node 24).
Las pruebas cargan los archivos reales de `js/` en un `vm` con un `window` mínimo y sustituyen
`fetch` y el reloj: no hacen peticiones de red ni esperan minutos reales.

| Prueba | Qué cubre |
|---|---|
| `tests/model.test.mjs` | Huella del modelo (ver abajo) |
| `tests/data.test.mjs` | Parseo de respuestas reales de Twelve Data, sesiones, velas suficientes por temporalidad, lotes, búsqueda y planes |
| `tests/api.test.mjs` | Cola, límites por minuto y por día, 429, errores, caché, cancelación |
| `tests/store.test.mjs` | `localStorage` con versión, migraciones (v1 → v2 → v3 → v4), datos dañados, cuota llena |
| `tests/watchlist.test.mjs` | Añadir, quitar, reordenar, máximo y persistencia |
| `tests/alerts.test.mjs` | Cada tipo de alerta con casos límite (umbral exacto, datos que faltan, cambio de día), ciclo de vida e historial |
| `tests/monitor.test.mjs` | Ritmo de actualización según el cupo y la frecuencia elegida, avisos y una pasada completa con respuestas reales |
| `tests/indicators.test.mjs` | MACD y Bollinger contra valores calculados a mano; que no entran en el modelo |
| `tests/compare.test.mjs` | % desde el inicio de la ventana, alineado con las fechas del valor principal |
| `tests/drawings.test.mjs` | Fecha ↔ posición en el gráfico, selección, movimiento, persistencia y migración v3 → v4 |
| `tests/backtest.test.mjs` | Que el backtest no usa datos futuros, cálculo de resultados y ejecución con velas reales |
| `tests/portfolio.test.mjs` | FIFO, ventas parciales, comisiones, dividendos, divisas, redondeos, validación, deshacer, importar/exportar, CSV y evolución (también con cierres reales) |
| `tests/harness.test.mjs` | Que `index.html` carga exactamente los `js/` y no tiene código en línea |

### Huella del modelo

`tests/fixtures/candles.json` contiene velas fijas y `tests/fixtures/model-fingerprint.json`
guarda el resultado de `Aura.model.analyze()` sobre ellas (probabilidades, cono, niveles,
recomendación y textos). Cualquier cambio en las reglas del modelo hace fallar
`tests/model.test.mjs`. Si un cambio es intencionado y está aprobado:

```sh
node tests/tools/update-fingerprint.mjs
```

Las velas fijas se generaron con un simulador determinista que vive solo en
`tests/tools/simulator.js` (no forma parte de la app).

### Respuestas reales de Twelve Data

`tests/fixtures/twelvedata/` guarda respuestas reales de la API: la mayoría capturadas con la clave
pública `demo` de Twelve Data (`node tests/tools/capture-twelvedata.mjs`) y algunas (cotizaciones en
lote, errores de plan y de símbolo) con una clave personal del plan Basic. Ninguna contiene claves.

## Estructura

| Archivo | Contenido |
|---|---|
| `index.html` | Estructura de la página; carga los scripts en orden con `defer` |
| `css/styles.css` | Estilos y tokens de diseño |
| `js/config.js` | Crea el espacio de nombres `Aura`; colores, temporalidades, límites de la API y caché |
| `js/utils.js` | Utilidades, calendario bursátil y formato es-ES |
| `js/store.js` | Almacenamiento local (`aura:v1`) con versión y migraciones |
| `js/api.js` | Cliente de Twelve Data: cola, límites, caché y errores |
| `js/data.js` | Capa de datos: `fetchMarketData`, `fetchQuotes`, `searchSymbols` |
| `js/indicators.js` | EMA, SMA, RSI, ATR, soportes y resistencias |
| `js/model.js` | Probabilidad de tendencia, cono de previsión y señal del modelo |
| `js/watchlist.js` | Watchlist: operaciones y persistencia |
| `js/alerts.js` | Alertas: tipos, evaluación, ciclo de vida e historial |
| `js/monitor.js` | Actualización periódica de cotizaciones y evaluación de alertas |
| `js/portfolio.js` | Cartera: FIFO, valoración, divisas, evolución, importar/exportar y deshacer |
| `js/drawings.js` | Dibujos: geometría y persistencia por valor |
| `js/backtest.js` | Backtest del modelo (sin datos futuros) y sus métricas |
| `js/state.js` | Estado compartido de la app |
| `js/chart-primitives.js` | Primitivas de dibujo para Lightweight Charts |
| `js/charts.js` | Gráficos sincronizados (precio, volumen, MACD, RSI), comparar, tooltip y leyenda |
| `js/panel.js` | Cabecera, estado de los datos, panel de análisis, watchlist y estado vacío |
| `js/settings.js` | Ajustes: clave de API y consumo |
| `js/watchlist-ui.js` | Diálogo de la watchlist y estrella de la cabecera |
| `js/alerts-ui.js` | Diálogo de alertas, notificaciones y contador |
| `js/portfolio-ui.js` | Vista «Cartera» |
| `js/compare-ui.js` | Diálogo «Comparar» |
| `js/drawing-tools.js` | Herramientas de dibujo sobre el gráfico |
| `js/backtest-ui.js` | Diálogo del backtest |
| `js/controls.js` | Temporalidad, indicadores, buscador y avisos |
| `js/main.js` | Arranque y ciclo de carga |
| `tests/` | Pruebas (`node --test`), arnés, fixtures y herramientas |
| `tools/serve.mjs` | Servidor estático de desarrollo |
