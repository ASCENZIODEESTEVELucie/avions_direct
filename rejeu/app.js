/* Rejouer le ciel — rejoue une journée de vols à partir des fichiers de donnees/.
   Aucun calcul de modèle ici : tout a été précalculé par preparer_demo.py (données froides). */
'use strict';

const $ = (id) => document.getElementById(id);
const ETATS_ENTRANT = {
  0: "c'est son premier vol de la journée",
  1: "l'avion qui arrive est au sol, à l'heure",
  2: "l'avion qui arrive n'est pas parti et a déjà du retard",
  3: "l'avion qui arrive est en l'air",
  4: "l'avion qui arrive s'est déjà posé",
};
const LENTILLES = {
  mondial: { titre: 'Le modèle mondial, 1 h avant', oui: 'alerte de retard', non: 'pas d\'alerte', inconnu: 'absent de l\'archive ADS-B' },
  mondial_15: { titre: 'Le modèle mondial, 15 min avant', oui: 'alerte de retard', non: 'pas d\'alerte', inconnu: 'absent de l\'archive ADS-B' },
  mondial_dec: { titre: 'Le modèle mondial, au décollage', oui: 'alerte de retard', non: 'pas d\'alerte', inconnu: 'absent de l\'archive ADS-B' },
  officiel: { titre: 'La vérité officielle', oui: 'en retard (15 min ou plus)', non: "à l'heure", inconnu: 'sans donnée' },
  modele: { titre: 'Le modèle BTS, 1 h avant', oui: 'alerte de retard', non: 'pas d\'alerte', inconnu: 'sans prédiction' },
  duree: { titre: 'Ma méthode par la durée', oui: 'vol anormalement long', non: 'durée normale', inconnu: 'route non modélisée' },
  horaire: { titre: "L'horaire reconstitué", oui: 'en retard (15 min ou plus)', non: "à l'heure", inconnu: 'horaire inconnu' },
};
/* La lentille « face à la vérité » : quatre cas, comme une matrice de confusion */
const CAS = {
  attrape: 'alerte, et vraiment en retard',
  manque: 'en retard, sans alerte',
  fausse: 'alerte, mais à l\'heure',
  calme: 'à l\'heure, sans alerte',
  inconnu: 'pas de prédiction (absent de l\'archive ADS-B)',
};
/* Le modèle jugé par la lentille « face à la vérité » : le mondial s'il existe ce jour-là, sinon le BTS */
const modeleFace = () => (etat.jour && etat.jour.seuil_mondial != null ? 'mondial' : 'modele');

const etat = { jour: null, vols: [], t0: 0, t: 0, lecture: false, vitesse: 300, lentille: 'mondial', choisi: null, index: null };
let carte, calque, contexte, couleurs, calquesFond = [];

/* ── Utilitaires ─────────────────────────────────────────────────────────── */
function lireCouleurs() {
  const s = getComputedStyle(document.documentElement);
  const v = (k) => s.getPropertyValue(k).trim();
  couleurs = { oui: v('--en-retard'), non: v('--a-l-heure'), inconnu: v('--inconnu'), encre: v('--encre'), fond: v('--panneau'),
               attrape: v('--attrape'), manque: v('--manque'), fausse: v('--fausse'), calme: v('--calme') };
}
const hhmm = (t) => {
  if (t == null) return '--:--';
  const d = new Date(t * 1000);
  const j = Math.floor((t - etat.t0) / 86400);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}${j > 0 ? ' +1 j' : ''}`;
};
const minutes = (s) => (s == null ? '—' : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
const signe = (m) => (m == null ? '—' : `${m > 0 ? '+' : ''}${Math.round(m)} min`);
const pct = (x) => (x == null ? '—' : `${(100 * x).toFixed(1).replace('.', ',')} %`);
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function vecteur(lat, lon) {
  return [Math.cos(rad(lat)) * Math.cos(rad(lon)), Math.cos(rad(lat)) * Math.sin(rad(lon)), Math.sin(rad(lat))];
}
/* Position sur le grand cercle entre départ et arrivée, à la fraction f du trajet */
function surGrandCercle(a, b, f) {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  if (om < 1e-9) return a;
  const s = Math.sin(om), k1 = Math.sin((1 - f) * om) / s, k2 = Math.sin(f * om) / s;
  return [k1 * a[0] + k2 * b[0], k1 * a[1] + k2 * b[1], k1 * a[2] + k2 * b[2]];
}
const versLatLon = (v) => [deg(Math.atan2(v[2], Math.hypot(v[0], v[1]))), deg(Math.atan2(v[1], v[0]))];

/* ── Verdicts selon la lentille ──────────────────────────────────────────── */
function verdict(v, lentille) {
  switch (lentille) {
    case 'modele': return v.proba == null ? null : v.proba >= etat.jour.seuil_alerte;
    case 'mondial': return v.proba_mondial == null || etat.jour.seuil_mondial == null ? null : v.proba_mondial >= etat.jour.seuil_mondial;
    case 'mondial_15': return v.proba_mondial_15 == null || etat.jour.seuil_mondial_15 == null ? null : v.proba_mondial_15 >= etat.jour.seuil_mondial_15;
    case 'mondial_dec': return v.proba_mondial_dec == null || etat.jour.seuil_mondial_decollage == null ? null : v.proba_mondial_dec >= etat.jour.seuil_mondial_decollage;
    case 'duree': return v.verdict_duree == null ? null : v.verdict_duree === 1;
    case 'horaire': return v.retard_horaire_min == null ? null : v.retard_horaire_min >= 15;
    default: return v.retard15_officiel == null ? null : v.retard15_officiel === 1;
  }
}
const couleurDe = (b) => (b == null ? couleurs.inconnu : b ? couleurs.oui : couleurs.non);
/* Le cas d'un vol : l'alerte (modèle) croisée avec la vérité officielle */
function cas(v) {
  const a = verdict(v, modeleFace()), o = verdict(v, 'officiel');
  if (a == null || o == null) return 'inconnu';
  return a ? (o ? 'attrape' : 'fausse') : (o ? 'manque' : 'calme');
}
/* La clé de couleur d'un vol dans la lentille courante */
function cle(v) {
  if (etat.lentille === 'face') return cas(v);
  const b = verdict(v, etat.lentille);
  return b == null ? 'inconnu' : b ? 'oui' : 'non';
}

/* ── Chargement ──────────────────────────────────────────────────────────── */
async function charger(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url} : réponse ${r.status}`);
  return r.json();
}

async function chargerJour(jour) {
  const d = await charger(`donnees/jour_${jour}.json`);
  const c = Object.fromEntries(d.colonnes.map((n, i) => [n, i]));
  etat.jour = d;
  etat.t0 = Date.UTC(+jour.slice(0, 4), +jour.slice(5, 7) - 1, +jour.slice(8, 10)) / 1000;
  etat.vols = d.vols.map((l, i) => {
    const v = Object.fromEntries(d.colonnes.map((n) => [n, l[c[n]]]));
    const o = d.aeroports[v.o], a = d.aeroports[v.d];
    v.id = i; v.a = vecteur(o[0], o[1]); v.b = vecteur(a[0], a[1]);
    return v;
  });
  etat.choisi = null;
  // Les regards du modèle mondial n'existent que pour les journées de sa période de test,
  // et ceux à 15 min et au décollage seulement si preparer_demo.py les a écrits.
  const dispo = {
    mondial: d.seuil_mondial != null,
    mondial_15: d.seuil_mondial_15 != null && etat.vols.some((v) => v.proba_mondial_15 != null),
    mondial_dec: d.seuil_mondial_decollage != null && etat.vols.some((v) => v.proba_mondial_dec != null),
  };
  for (const [n, ok] of Object.entries(dispo)) {
    const b = document.querySelector(`.lentilles button[data-lentille="${n}"]`);
    if (b) b.hidden = !ok;
  }
  if (dispo[etat.lentille] === false) choisirLentille(dispo.mondial ? 'mondial' : 'modele');
  const fin = Math.max(...etat.vols.map((v) => v.t_on)) - etat.t0;
  $('curseur').max = Math.ceil(fin / 3600) * 3600;
  etat.t = etat.t0 + 14 * 3600;  // on ouvre à 14 h UTC (10 h à New York), quand le ciel américain est plein
  carte.fitBounds(Object.values(d.aeroports).map(([la, lo]) => [la, lo]), { padding: [40, 40] });
  $('liste-indicatifs').replaceChildren(...[...new Set(etat.vols.map((v) => v.callsign))].sort()
    .map((cs) => Object.assign(document.createElement('option'), { value: cs })));
  afficherVol(null);
  afficherJournee();
  majTemps();
}

/* ── La carte ────────────────────────────────────────────────────────────── */
function creerCarte() {
  carte = L.map('carte', { zoomControl: true, worldCopyJump: true, attributionControl: true }).setView([38.5, -96], 4);
  // Fond de carte embarqué (Natural Earth, domaine public) : aucune clé, aucun service tiers, fonctionne hors ligne.
  carte.attributionControl.setPrefix(false);
  carte.attributionControl.addAttribution('Fond : <a href="https://www.naturalearthdata.com/">Natural Earth</a> · vols : BTS · <a href="https://leafletjs.com">Leaflet</a>');
  fetch('vendor/fond_carte.json').then((r) => r.json()).then((fond) => {
    const rendu = L.canvas({ padding: 0.5 });
    const style = (cle, extra) => () => ({ renderer: rendu, interactive: false, ...extra(getComputedStyle(document.documentElement).getPropertyValue(cle).trim()) });
    calquesFond = [
      L.geoJSON(fond.terre, { style: style('--terre', (c) => ({ fillColor: c, fillOpacity: 1, stroke: false })) }),
      L.geoJSON(fond.frontieres, { style: style('--limite', (c) => ({ color: c, weight: 1.2, fill: false })) }),
      L.geoJSON(fond.etats, { style: style('--limite', (c) => ({ color: c, weight: 0.6, fill: false, dashArray: '2 3' })) }),
    ];
    calquesFond.forEach((c) => c.addTo(carte));
  }).catch(() => {});   // sans fond, la carte reste lisible : avions et aéroports

  calque = document.createElement('canvas');
  Object.assign(calque.style, { position: 'absolute', inset: '0', zIndex: 450, pointerEvents: 'none' });
  carte.getContainer().appendChild(calque);
  contexte = calque.getContext('2d');
  const taille = () => {
    const r = carte.getContainer().getBoundingClientRect(), p = devicePixelRatio || 1;
    calque.width = r.width * p; calque.height = r.height * p;
    calque.style.width = `${r.width}px`; calque.style.height = `${r.height}px`;
    contexte.setTransform(p, 0, 0, p, 0, 0);
    dessiner();
  };
  carte.on('move zoom resize', dessiner);
  carte.on('resize', taille);
  new ResizeObserver(taille).observe(carte.getContainer());
  carte.on('click', (e) => choisirPres(e.containerPoint));
  taille();
}

function positions() {
  const t = etat.t, out = [];
  for (const v of etat.vols) {
    if (t < v.t_off || t > v.t_on) continue;
    const f = (t - v.t_off) / (v.t_on - v.t_off);
    const p = versLatLon(surGrandCercle(v.a, v.b, f));
    const q = versLatLon(surGrandCercle(v.a, v.b, Math.min(1, f + 0.01)));
    out.push({ v, p, q });
  }
  return out;
}

function dessiner() {
  if (!contexte || !etat.jour) return;
  const w = calque.clientWidth, h = calque.clientHeight;
  contexte.clearRect(0, 0, w, h);
  // aéroports
  contexte.font = '600 11px Overpass, system-ui, sans-serif';
  for (const [code, [lat, lon]] of Object.entries(etat.jour.aeroports)) {
    const pt = carte.latLngToContainerPoint([lat, lon]);
    contexte.fillStyle = couleurs.encre; contexte.globalAlpha = 0.55;
    contexte.fillRect(pt.x - 2, pt.y - 2, 4, 4);
    if (carte.getZoom() >= 4) contexte.fillText(code, pt.x + 5, pt.y - 4);
  }
  contexte.globalAlpha = 1;
  // trajet du vol choisi
  const ch = etat.choisi;
  if (ch) {
    contexte.strokeStyle = couleurs.encre; contexte.lineWidth = 1.5; contexte.setLineDash([4, 4]);
    contexte.beginPath();
    for (let i = 0; i <= 40; i++) {
      const pt = carte.latLngToContainerPoint(versLatLon(surGrandCercle(ch.a, ch.b, i / 40)));
      i ? contexte.lineTo(pt.x, pt.y) : contexte.moveTo(pt.x, pt.y);
    }
    contexte.stroke(); contexte.setLineDash([]);
  }
  // avions
  const compte = {};
  etat.visibles = [];
  for (const { v, p, q } of positions()) {
    const pt = carte.latLngToContainerPoint(p), pq = carte.latLngToContainerPoint(q);
    const cap = Math.atan2(pq.y - pt.y, pq.x - pt.x);          // direction à l'écran
    if (pt.x < -10 || pt.y < -10 || pt.x > w + 10 || pt.y > h + 10) continue;
    const k = cle(v);
    compte[k] = (compte[k] || 0) + 1;
    const r = v === ch ? 8 : 4.5;
    contexte.save();
    contexte.translate(pt.x, pt.y); contexte.rotate(cap + Math.PI / 2);   // la pointe (vers -y) suit le cap
    contexte.beginPath(); contexte.moveTo(0, -r * 1.5); contexte.lineTo(r * 0.9, r); contexte.lineTo(0, r * 0.45);
    contexte.lineTo(-r * 0.9, r); contexte.closePath();
    if (v === ch) { contexte.lineWidth = 4; contexte.strokeStyle = couleurs.fond; contexte.stroke(); }
    contexte.fillStyle = couleurs[k]; contexte.fill();
    if (v === ch) { contexte.lineWidth = 1.5; contexte.strokeStyle = couleurs.encre; contexte.stroke(); }
    contexte.restore();
    etat.visibles.push({ v, x: pt.x, y: pt.y });
  }
  afficherLegende(compte);
}

function afficherLegende(c) {
  const ligne = (k, txt) => `<span><i class="pastille" style="background:${couleurs[k]}"></i>${txt} : ${c[k] || 0}</span>`;
  let html;
  if (etat.lentille === 'face') {
    html = `<strong>${LENTILLES[modeleFace()].titre}, face à la vérité</strong>`
      + ['attrape', 'manque', 'fausse', 'calme'].map((k) => ligne(k, CAS[k])).join('')
      + (c.inconnu ? ligne('inconnu', CAS.inconnu) : '');
  } else {
    const l = LENTILLES[etat.lentille];
    html = `<strong>${l.titre}</strong>` + ligne('oui', l.oui) + ligne('non', l.non) + (c.inconnu ? ligne('inconnu', l.inconnu) : '');
  }
  $('legende').innerHTML = html;
  $('compte').textContent = `${Object.values(c).reduce((a, b) => a + b, 0)} avions en vol`;
}

function choisirLentille(nom) {
  etat.lentille = nom;
  document.querySelectorAll('.lentilles button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.lentille === nom)));
  dessiner();
}

function choisirPres(pt) {
  let mieux = null, d2 = 14 * 14;
  for (const s of etat.visibles || []) {
    const d = (s.x - pt.x) ** 2 + (s.y - pt.y) ** 2;
    if (d < d2) { d2 = d; mieux = s.v; }
  }
  if (mieux) choisir(mieux);
}

function choisir(v) {
  etat.choisi = v;
  ouvrirOnglet('vol');
  afficherVol(v);
  dessiner();
}

/* ── Le temps ────────────────────────────────────────────────────────────── */
function majTemps() {
  $('curseur').value = Math.round(etat.t - etat.t0);
  $('horloge').textContent = `${hhmm(etat.t)} UTC`;
  dessiner();
}
let dernier = null;
function boucle(ts) {
  if (!etat.lecture) { dernier = null; return; }
  if (dernier != null) {
    etat.t += ((ts - dernier) / 1000) * etat.vitesse;
    if (etat.t - etat.t0 > +$('curseur').max) etat.t = etat.t0;
    majTemps();
  }
  dernier = ts;
  requestAnimationFrame(boucle);
}
function basculerLecture(forcer) {
  etat.lecture = forcer ?? !etat.lecture;
  $('lecture').textContent = etat.lecture ? '❚❚' : '▶';
  $('lecture').setAttribute('aria-label', etat.lecture ? 'Mettre en pause' : 'Lancer la lecture');
  if (etat.lecture) requestAnimationFrame(boucle);
}

/* ── Le panneau : un vol ─────────────────────────────────────────────────── */
function jauge(valeur, min, max, repere, couleur, gauche, droite) {
  const x = (u) => `${Math.max(0, Math.min(100, (100 * (u - min)) / (max - min)))}%`;
  return `<div class="jauge"><div class="rempli" style="width:${x(valeur)};background:${couleur}"></div>`
    + (repere != null ? `<div class="repere" style="left:${x(repere)}"></div>` : '')
    + `</div><div class="jauge-legende"><span>${gauche}</span><span>${droite}</span></div>`;
}
function puce(b, l) {
  const txt = b == null ? l.inconnu : b ? l.oui : l.non;
  return `<p class="verdict"><i class="pastille" style="background:${couleurDe(b)}"></i>${txt.charAt(0).toUpperCase() + txt.slice(1)}</p>`;
}

function afficherVol(v) {
  const z = $('volet-vol');
  if (!v) { z.innerHTML = '<p class="vide">Cliquez sur un avion, ou cherchez un vol par son indicatif.</p>'; return; }
  const J = etat.jour, officiel = verdict(v, 'officiel');
  const bm = verdict(v, 'modele'), bd = verdict(v, 'duree'), bh = verdict(v, 'horaire');
  const mf = modeleFace(), bf = verdict(v, mf), c = cas(v);
  const probaF = mf === 'mondial' ? v.proba_mondial : v.proba, seuilF = mf === 'mondial' ? J.seuil_mondial : J.seuil_alerte;

  const horaires = [
    ['Départ prévu', hhmm(v.t_dep_prevu)], ['Décollage', hhmm(v.t_off)],
    ['Arrivée prévue', hhmm(v.t_arr_prevu)], ['Atterrissage', hhmm(v.t_on)],
  ].map(([e, val]) => `<div class="ligne"><span class="etiquette">${e}</span><span class="valeur">${val}</span></div>`).join('');

  // 1. Une heure avant le départ : ce que l'on savait, et l'alerte
  const avant = probaF == null
    ? `<p class="vide">${mf === 'mondial' ? "Ce vol n'est pas dans l'archive ADS-B : pas de prédiction mondiale." : 'Pas de prédiction pour ce vol.'}</p>`
    : `${puce(bf, LENTILLES[mf])}
       ${jauge(probaF, 0, 1, seuilF, couleurDe(bf), 'probabilité ' + pct(probaF), 'seuil ' + pct(seuilF))}`;
  const entrant = `<dl class="faits">
      <dt>L'avion qui arrive</dt><dd>${v.etat_entrant == null ? '—' : ETATS_ENTRANT[v.etat_entrant]}</dd>
      <dt>Son retard connu</dt><dd>${v.retard_entrant_min == null ? '—' : signe(v.retard_entrant_min)}</dd>
      <dt>Marge prévue entre les deux vols</dt><dd>${v.marge_rotation_min == null ? '—' : v.marge_rotation_min + ' min'}</dd>
    </dl>`;

  // Les autres instants du modèle mondial, s'ils ont été préparés
  const autres = [['mondial_15', v.proba_mondial_15, J.seuil_mondial_15], ['mondial_dec', v.proba_mondial_dec, J.seuil_mondial_decollage]]
    .filter(([, p, s]) => p != null && s != null)
    .map(([n, p, s]) => { const b = p >= s; return `<p class="verdict"><i class="pastille" style="background:${couleurDe(b)}"></i>${LENTILLES[n].titre.replace('Le modèle mondial, ', '')} : ${pct(p)} (seuil ${pct(s)}), ${b ? 'alerte' : "pas d'alerte"}</p>`; })
    .join('');

  // 2. La vérité, et le bilan en une phrase
  const bilan = { attrape: 'Retard annoncé une heure avant : le modèle avait vu juste.',
                  manque: "Retard non annoncé : le modèle l'a manqué.",
                  fausse: "Alerte donnée, mais le vol est arrivé à l'heure.",
                  calme: "Pas d'alerte, et le vol est arrivé à l'heure : le modèle avait vu juste." }[c];

  // 3. Les autres regards, repliés
  const detailDuree = v.seuil_route_s == null ? 'route trop rare pour avoir un seuil'
    : `${minutes(v.air_time_s)} en l'air pour ${minutes(v.mediane_route_s)} d'habitude (seuil ${minutes(v.seuil_route_s)})`;
  const detailHoraire = v.arr_prevue_rec == null ? "horaire inconnu (vol non vu le mois précédent)"
    : `arrivée habituelle ${hhmm(v.arr_prevue_rec)}, retard calculé ${signe(v.retard_horaire_min)}`;

  z.innerHTML = `
    <p class="route"><span class="code">${v.o}</span><span class="fleche" aria-hidden="true">→</span><span class="code">${v.d}</span></p>
    <p class="identite">Vol ${v.callsign}, avion ${v.immat}, ${Math.round(v.distance_km).toLocaleString('fr-FR')} km. Heures en UTC.</p>
    <div class="tableau" role="table" aria-label="Horaires du vol">${horaires}</div>
    <section class="regard"><h3>1 h avant le départ</h3>
      ${entrant}${avant}${autres}</section>
    <section class="regard"><h3>Ce qui s'est passé</h3>
      ${puce(officiel, LENTILLES.officiel)}
      <dl class="faits"><dt>Retard à l'arrivée</dt><dd>${signe(v.retard_officiel_min)}</dd>
        <dt>Cause déclarée</dt><dd>${v.cause || '—'}</dd></dl>
      ${bilan ? `<p class="bilan" style="border-color:${couleurs[c]}">${bilan}</p>` : ''}
    </section>
    <details class="plus"><summary>Les autres regards sur ce vol</summary>
      <dl class="faits">
        ${mf === 'mondial' ? `<dt>Le modèle BTS, 1 h avant</dt><dd>${v.proba == null ? '—' : `${pct(v.proba)}, ${bm ? 'alerte' : "pas d'alerte"} (seuil ${pct(J.seuil_alerte)})`}</dd>` : ''}
        <dt>Ma méthode par la durée</dt><dd>${detailDuree}${bd == null ? '' : bd ? ' : anormalement long' : ' : durée normale'}</dd>
        <dt>L'horaire reconstitué</dt><dd>${detailHoraire}${bh == null ? '' : bh ? ' : en retard' : " : à l'heure"}</dd>
      </dl>
    </details>`;
}

/* ── Le panneau : la journée ─────────────────────────────────────────────── */
function afficherJournee() {
  const r = etat.jour.resume, a = etat.jour.appris_sur, mf = modeleFace();
  const sur100 = (x) => (x == null ? '—' : Math.round(100 * x));
  const pr = (x) => `${pct(x.precision)} / ${pct(x.rappel)}`;
  const periode = (p) => (p ? `du ${p[0]} au ${p[1]}` : '—');
  const n = { attrape: 0, manque: 0, fausse: 0, calme: 0, inconnu: 0 };
  for (const v of etat.vols) n[cas(v)]++;
  const resM = mf === 'mondial' ? r.mondial : r.modele;
  const ligne = (k) => `<li><i class="pastille" style="background:${couleurs[k]}"></i><span>${CAS[k]}</span><span class="chiffre">${n[k].toLocaleString('fr-FR')}</span></li>`;
  const autres = [
    r.modele && mf === 'mondial' ? ['Le modèle BTS, 1 h avant', pr(r.modele), 'précision / rappel, tous les vols'] : null,
    r.mondial_decollage ? ['Le modèle mondial, au décollage', pr(r.mondial_decollage), `précision / rappel, ${pct(r.mondial_decollage.couverture)} des vols`] : null,
    ["L'horaire reconstitué", pr(r.horaire), `précision / rappel, ${pct(r.horaire.couverture)} des vols`],
    ['Ma méthode par la durée', pr(r.duree), 'face aux vols qui ont duré 15 min de trop'],
  ].filter(Boolean).map(([t, c, d]) => `<dt>${t}</dt><dd><span class="chiffre-petit">${c}</span> ${d}</dd>`).join('');

  $('volet-jour').innerHTML = `
    <div class="mesure"><h3>${r.vols.toLocaleString('fr-FR')} vols rejoués</h3>
      <p>Entre les ${Object.keys(etat.jour.aeroports).length} plus grands aéroports américains, le ${etat.jour.jour}. ${sur100(r.taux_retard_officiel)} sur 100 sont arrivés en retard.</p></div>
    ${resM ? `<div class="mesure"><h3>${LENTILLES[mf].titre}</h3>
      <p><span class="chiffre">${sur100(resM.rappel)}</span> retards sur 100 attrapés</p>
      <p><span class="chiffre">${sur100(resM.precision)}</span> alertes sur 100 justes</p>
      ${mf === 'mondial' ? `<p>Sur les ${pct(r.mondial.couverture)} de vols retrouvés dans l'archive ADS-B, jamais vus pendant l'apprentissage.</p>` : ''}</div>` : ''}
    <ul class="cas">${['attrape', 'manque', 'fausse', 'calme'].map(ligne).join('')}</ul>
    <details class="plus"><summary>Les autres regards et les chiffres du mémoire</summary>
      <dl class="faits">${autres}</dl>
      ${etat.index ? `<ul class="memoire">${etat.index.chiffres_memoire.map((c) => `
        <li><div>${c.titre}</div><div class="valeur">${c.valeur}</div><div class="detail">${c.detail} (section ${c.section}).</div></li>`).join('')}</ul>` : ''}
      <p class="note">Rien de ce qui est affiché « avant le départ » ne vient du futur : le modèle BTS a appris ${periode(a.modele)} ;${a.modele_mondial ? ` le modèle mondial a appris ${periode(a.modele_mondial)} et choisi son seuil ${periode(a.seuil_mondial_choisi_sur)} ;` : ''} l'horaire ${periode(a.horaire)}.
        ${etat.index ? `Sources : ${etat.index.sources}.` : ''}</p>
    </details>`;
}

function ouvrirOnglet(nom) {
  for (const n of ['vol', 'jour']) {
    $(`onglet-${n}`).setAttribute('aria-selected', String(n === nom));
    $(`volet-${n}`).hidden = n !== nom;
  }
}

/* ── Démarrage ───────────────────────────────────────────────────────────── */
async function demarrer() {
  lireCouleurs();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { lireCouleurs(); calquesFond.forEach((c) => c.resetStyle()); dessiner(); });
  creerCarte();
  for (const n of ['vol', 'jour']) $(`onglet-${n}`).addEventListener('click', () => ouvrirOnglet(n));
  document.querySelectorAll('.lentilles button').forEach((b) => b.addEventListener('click', () => choisirLentille(b.dataset.lentille)));
  $('lecture').addEventListener('click', () => basculerLecture());
  $('curseur').addEventListener('input', (e) => { etat.t = etat.t0 + +e.target.value; majTemps(); });
  $('vitesse').addEventListener('change', (e) => { etat.vitesse = +e.target.value; });
  $('recherche').addEventListener('submit', (e) => {
    e.preventDefault();
    const cs = $('champ-recherche').value.trim().toUpperCase();
    const v = etat.vols.find((x) => x.callsign === cs);
    if (!v) { $('champ-recherche').setCustomValidity(`Aucun vol ${cs} ce jour-là.`); $('champ-recherche').reportValidity(); return; }
    $('champ-recherche').setCustomValidity('');
    if (etat.t < v.t_off || etat.t > v.t_on) { etat.t = (v.t_off + v.t_on) / 2; majTemps(); }
    choisir(v);
  });
  $('champ-recherche').addEventListener('input', () => $('champ-recherche').setCustomValidity(''));
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName)) { e.preventDefault(); basculerLecture(); }
  });
  try {
    const index = await charger('donnees/index.json');
    etat.index = index;
    $('choix-jour').replaceChildren(...index.jours.map((j) => Object.assign(document.createElement('option'), { value: j, textContent: j })));
    $('choix-jour').addEventListener('change', (e) => chargerJour(e.target.value));
    await chargerJour(index.jours[0]);
  } catch (err) {
    const e = $('erreur');
    e.hidden = false;
    e.textContent = location.protocol === 'file:'
      ? "Le navigateur bloque la lecture des données quand la page est ouverte comme un fichier. Lancez « python -m http.server » dans le dossier demo, puis ouvrez http://localhost:8000, ou passez par l'API (adresse /demo/)."
      : `Les données de la démo sont introuvables (${err.message}). Lancez d'abord preparer_demo.py pour remplir le dossier donnees/.`;
  }
}
demarrer();
