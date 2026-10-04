# Aura Invest

Plataforma web de análisis bursátil con **datos reales de [Twelve Data](https://twelvedata.com/)**:
gráfico de velas con EMA 20, SMA 50, soportes y resistencias, volumen y RSI sincronizados, más
un panel «AI Analytics» con probabilidad de tendencia, cono de previsión a 3 meses y
recomendación táctica.

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
| `tests/store.test.mjs` | `localStorage` con versión, migraciones, datos dañados, cuota llena |
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

`tests/fixtures/twelvedata/` guarda respuestas reales de la API, capturadas con la clave pública
`demo` de Twelve Data (`node tests/tools/capture-twelvedata.mjs`). Ninguna contiene claves.

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
| `js/model.js` | Probabilidad de tendencia, cono de previsión y recomendación |
| `js/state.js` | Estado compartido de la app |
| `js/chart-primitives.js` | Primitivas de dibujo para Lightweight Charts |
| `js/charts.js` | Gráficos sincronizados, tooltip y leyenda |
| `js/panel.js` | Cabecera, estado de los datos, panel AI Analytics, watchlist y estado vacío |
| `js/settings.js` | Ajustes: clave de API y consumo |
| `js/controls.js` | Temporalidad, indicadores, buscador y avisos |
| `js/main.js` | Arranque y ciclo de carga |
| `tests/` | Pruebas (`node --test`), arnés, fixtures y herramientas |
| `tools/serve.mjs` | Servidor estático de desarrollo |
