/**
 * «Huella» de Aura.model.analyze(): todo lo que el modelo decide o muestra.
 * Si cualquier regla del modelo cambia (pesos, umbrales, cono, niveles, textos),
 * la huella cambia y el test de tests/model.test.mjs falla.
 * Los números se redondean a 12 cifras significativas: suficiente para detectar
 * cualquier cambio real y tolerante a reordenaciones de operaciones equivalentes.
 */
const round = (_, v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(12)) : v);

function series(arr) {
  const vals = arr.filter((v) => v != null);
  return { count: vals.length, first: vals[0] ?? null, last: vals.at(-1) ?? null, sum: vals.reduce((a, b) => a + b, 0) };
}

export function fingerprint(m) {
  return JSON.parse(JSON.stringify({
    window: {
      bars: m.bars.length, ws: m.ws, visible: m.vis.length,
      firstVisible: m.vis[0].time, lastVisible: m.vis.at(-1).time,
    },
    indicators: Object.fromEntries(Object.entries(m.ind).map(([k, arr]) => [k, series(arr)])),
    trend: {
      score: m.trend.score, probs: m.trend.probs, conf: m.trend.conf, level: m.trend.level,
      factors: m.trend.factors.map(({ label, weight, score, reading }) => ({ label, weight, score, reading })),
      details: m.trend.details,
    },
    sr: m.sr,
    forecast: {
      P0: m.fc.P0, muDay: m.fc.muDay, sigmaDay: m.fc.sigmaDay,
      sigmaAnnual: m.fc.sigmaAnnual, muAnnual: m.fc.muAnnual, upside: m.fc.upside,
      end: m.fc.end, horizonT: m.fc.horizonT, points: m.fc.points,
    },
    advisory: m.adv,
    rationale: m.rationale,
  }, round));
}
