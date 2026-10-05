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
temporalidad, agrupa cotizaciones en lotes y muestra el consumo del día (las peticiones que no
llegan a salir por falta de conexión no cuentan). El plan Basic cubre
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
  navegador, que se muestran mediante un *service worker* mínimo (`sw.js`, sin caché: Chrome para
  Android no admite otra forma). Necesitan una conexión segura (https o `localhost`); en iPhone
  solo las tienen las webs añadidas a la pantalla de inicio. Si el navegador se niega a mostrar una,
  la app deja de prometerlas y los avisos siguen dentro de la app.
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
- Si Twelve Data no responde, se usan los últimos datos guardados con el aviso «Datos antiguos» y
  se indica qué cotizaciones, cierres diarios o tipos de cambio son antiguos y de cuándo.
- ***Splits***: el endpoint de splits de Twelve Data no entra en el plan gratuito (cuesta 20 créditos y
  requiere el plan Grow), así que la app los deduce comparando los cierres tal cual cotizaron con los
  ajustados (1 crédito más por acción, en caché 12 h). Si alguna compra o venta anterior a un split
  está anotada en acciones de antes, avisa del factor por el que corregirla; no cambia nada sola.

## Más análisis

- **Barra del gráfico**: temporalidad, menú «Indicadores» (EMA 20, SMA 50, soportes y resistencias,
  proyección 3M, Bollinger y MACD, con el número de activos), «Comparar», menú «Dibujo» y ajustar
  vista. Los menús se abren con el ratón, el dedo o el teclado; Escape los cierra y devuelve el foco.
- **MACD (12, 26, 9)** en su propio panel y **Bandas de Bollinger (20, 2)** sobre el precio, en el
  menú «Indicadores», la leyenda y el tooltip. Son solo visuales: no entran en la puntuación del modelo.
- **Comparar**: superpone hasta 4 valores en % desde el inicio de la ventana. Mientras se compara,
  el gráfico usa un único eje en % (se ocultan velas e indicadores en precio). En intradía las
  series se alinean en hora UTC real, aunque sean de bolsas con husos distintos.
- **Horas del gráfico** (intradía): las acciones, en la hora de su bolsa; el forex y la cripto, en
  tu hora local (Twelve Data da el forex en hora de Sídney) y con sesión de 24 h. La barra de
  estado indica cuál se usa.
- **Dibujo** (menú «Dibujo»): líneas horizontales y de tendencia, guardadas por valor. Se mueven arrastrando (también
  con el dedo, con una zona para agarrar más ancha) o con ↑/↓ y se borran con Supr; el diálogo
  «Dibujos» permite editarlas y borrarlas con teclado o con el dedo. Si el sistema interrumpe un
  arrastre, se descarta y el gráfico vuelve a moverse.
- **Backtest del modelo** con velas reales: diarias (2, 5 o 10 años) o semanales (todo el
  histórico), de un valor o de toda la watchlist (1 crédito por valor). En cada vela se ejecuta el
  modelo solo con lo que se sabía entonces y luego se mide:
  - el acierto y la rentabilidad de cada señal frente a no hacer nada y, como los días seguidos
    comparten casi todo su futuro, la diferencia con cualquier día con un **intervalo del 90 % por
    bootstrap de bloques** y cuántos periodos independientes hay;
  - cuántas veces acabó el precio dentro del cono del 80 % (con su intervalo);
  - en las señales Alcista ya cerradas, si se tocó antes el objetivo o el stop, su resultado en R y
    el de la misma operación abierta un día cualquiera;
  - estrategias sencillas (solo con Alcista, fuera con Bajista) frente a comprar y mantener, con una
    **comisión** configurable que se recalcula sin pedir datos.

  Con varios valores se ve una tabla comparativa. Los resultados se muestran tal cual, aunque sean
  peores que el azar. Intradía no se ofrece: 5000 velas de 5 min (unas 64 sesiones) no llegan al
  horizonte de 63 sesiones más el calentamiento.

### Revisión del modelo (octubre de 2026)

Backtest con velas diarias reales de AAPL, MSFT, NVDA, KO, SAN (ADR) y EUR/USD a 5, 10 y ~19 años:

- **La dirección no tiene una ventaja que se repita.** Tras una señal Alcista o Bajista, la
  rentabilidad a 3 meses es casi siempre indistinguible de la de cualquier día; en AAPL y KO la
  Bajista va al revés (el precio sube más de lo normal) y en NVDA acierta. Por eso no se han
  tocado pesos ni umbrales: ajustarlos con tan pocos valores sería sobreajustar.
- **Bajista ya no propone operación en corto.** Esos cortos perdían de media (en R) en los seis
  valores a 10 años. El panel mantiene la señal y sus probabilidades y muestra el soporte S1 como
  nivel a vigilar.
- **Cono del 80 %: la σ diaria usa las últimas 250 sesiones** (antes 120) de la serie descargada,
  igual en 6M, YTD y 1A. El error medio de cobertura frente al 80 % bajó de 3,6 a 1,8 puntos a
  5 años (AAPL: del 72,8 % al 78,1 %). En valores con una subida muy fuerte (NVDA) el precio sigue
  saliéndose por arriba más de lo previsto. Intradía y semanal no cambian.
- Que el stop se toque antes que el objetivo en la mitad de las señales Alcista es lo esperable
  con un riesgo/beneficio de ≈ 1:1,9 (basta con acertar ~34 % para no perder); su resultado en R
  es similar al de la misma operación abierta un día cualquiera.

## Cómo probarla

```sh
node --test "tests/*.test.mjs"
```

Requiere Node con soporte de patrones en `--test` (Node 21 o posterior; probado con Node 24).
Las pruebas cargan los archivos reales de `js/` en un `vm` con un `window` mínimo y sustituyen
`fetch` y el reloj: no hacen peticiones de red ni esperan minutos reales.

| Prueba | Qué cubre |
|---|---|
| `tests/model.test.mjs` | Huella del modelo (ver abajo), Bajista sin operación en corto y σ del cono igual en 6M, YTD y 1A |
| `tests/data.test.mjs` | Parseo de respuestas reales de Twelve Data, sesiones, velas suficientes por temporalidad, lotes, búsqueda y planes |
| `tests/api.test.mjs` | Cola, límites por minuto y por día, 429, errores, caché, cancelación |
| `tests/store.test.mjs` | `localStorage` con versión, migraciones (v1 → v2 → v3 → v4 → v5), datos dañados, cuota llena |
| `tests/watchlist.test.mjs` | Añadir, quitar, reordenar, máximo y persistencia |
| `tests/alerts.test.mjs` | Cada tipo de alerta con casos límite (umbral exacto, datos que faltan, cambio de día), ciclo de vida e historial |
| `tests/monitor.test.mjs` | Ritmo de actualización según el cupo y la frecuencia elegida, avisos y una pasada completa con respuestas reales |
| `tests/indicators.test.mjs` | MACD y Bollinger contra valores calculados a mano; que no entran en el modelo |
| `tests/compare.test.mjs` | % desde el inicio de la ventana, alineado con las fechas del valor principal |
| `tests/timezones.test.mjs` | Desfases con horario de verano, forex y cripto en hora local con sesión de 24 h, migración v4 → v5 de sus líneas de tendencia y Comparar en intradía alineado en UTC (con velas reales de AAPL y EUR/USD) |
| `tests/drawings.test.mjs` | Fecha ↔ posición en el gráfico, selección, movimiento, persistencia y migración v3 → v4 |
| `tests/backtest.test.mjs` | Que el backtest no usa datos futuros, cálculo de resultados, R, estrategias con comisión e intervalos por bloques (a mano), modo semanal y ejecución con velas reales |
| `tests/portfolio.test.mjs` | FIFO, ventas parciales, comisiones, dividendos, divisas, redondeos, validación, deshacer, importar/exportar, CSV y evolución (también con cierres reales) |
| `tests/harness.test.mjs` | Que `index.html` carga exactamente los `js/` y no tiene código en línea |

### En un navegador real

```sh
node tools/browser-check.mjs            # sin clave de API: 0 créditos
node tools/browser-check.mjs --demo     # además, con la clave pública «demo» (AAPL y EUR/USD)
```

Abre Edge o Chrome (sin ventana; `--headed` para verla) con un perfil temporal que borra al
terminar, por CDP y sin dependencias (Node 22 o posterior). Comprueba que la app carga sin errores
en consola, los diálogos y las pestañas con teclado (foco y Escape), que todos los controles tienen
nombre accesible y que no hay desplazamiento horizontal a 390, 768 y 1440 px. Con `--demo`, además:
panel del modelo en español, barra del gráfico en una fila con sus menús por teclado, dibujo con
ratón, teclado y dedo (incluido un gesto cancelado) y desplazamiento del gráfico con el dedo,
Comparar (también en intradía con husos distintos), backtest (con teclado, de toda la watchlist y
semanal, con comisiones), notificaciones por el *service worker* (también con el comportamiento de
Chrome para Android), aviso de split en la Cartera y forex en hora local. Gasta solo créditos de la
clave `demo`. Guarda capturas en una carpeta temporal (o en `--out=<carpeta>`).
No forma parte de `node --test`.

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
| `sw.js` | *Service worker* mínimo: solo muestra las notificaciones de las alertas (no intercepta ni guarda nada) |
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
| `tools/browser-check.mjs` | Comprobación en un navegador real por CDP (fuera de `node --test`) |
