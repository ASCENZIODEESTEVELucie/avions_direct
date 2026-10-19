/* Le ciel en direct — DST Airlines (mémoire, section 10.4).
 *
 * La page lit UNE photo des vols en cours, déposée par la VM chez Cloudflare toutes les 16 minutes.
 * Entre deux photos, chaque avion avance « à l'estime » :
 *   - le long du chemin habituel de sa route (notebook 07 quater) quand il existe ;
 *   - sinon sur le plus court chemin vers son aéroport d'arrivée (« trajet incertain ») ;
 *   - sinon (route inconnue), il reste à sa dernière position connue.
 * Il disparaît 20 minutes après son heure d'arrivée estimée.
 */
(function () {
  'use strict';
  const CFG = window.DST_DIRECT;
  const R_TERRE = 6371;
  const FRAIS_S = 120;                 // en deçà : position « reçue » ; au-delà : position « estimée »
  const APRES_ARRIVEE_S = 20 * 60;     // un avion disparaît 20 min après son arrivée estimée
  const VERDICTS = [
    { cle: 'normal', nom: 'Dans la norme de sa route', couleur: '--normal' },
    { cle: 'anormal', nom: 'Plus long que le seuil de sa route', couleur: '--anormal' },
    { cle: 'route douteuse', nom: 'Route douteuse (hors de l\'axe)', couleur: '--douteux' },
    { cle: 'inconnu', nom: 'Pas encore jugé', couleur: '--inconnu' },
  ];
  const visibles = new Set(VERDICTS.map((v) => v.cle));

  let carte, calque, ctx, photo = null, avions = [], trajets = {}, choisi = null, recuLe = null;

  /* ── Géométrie sur la sphère ─────────────────────────────────────────── */
  const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
  function xyz(lat, lon) { const a = rad(lat), o = rad(lon); return [Math.cos(a) * Math.cos(o), Math.cos(a) * Math.sin(o), Math.sin(a)]; }
  function latlon(v) { const n = Math.hypot(v[0], v[1], v[2]); return [deg(Math.asin(v[2] / n)), deg(Math.atan2(v[1], v[0]))]; }
  function distKm(a1, o1, a2, o2) {
    const d = Math.sin(rad(a2 - a1) / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(rad(o2 - o1) / 2) ** 2;
    return 2 * R_TERRE * Math.asin(Math.min(1, Math.sqrt(d)));
  }
  // point à la fraction f du grand cercle entre deux points (interpolation sphérique)
  function grandCercle(a1, o1, a2, o2, f) {
    const p = xyz(a1, o1), q = xyz(a2, o2);
    const w = Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
    if (w < 1e-9) return [a1, o1];
    const s = Math.sin(w), k1 = Math.sin((1 - f) * w) / s, k2 = Math.sin(f * w) / s;
    return latlon([k1 * p[0] + k2 * q[0], k1 * p[1] + k2 * q[1], k1 * p[2] + k2 * q[2]]);
  }

  // Un chemin = des points ; on garde la distance cumulée pour avancer d'un nombre de km donné.
  function preparerChemin(pts) {
    const cumul = [0];
    for (let i = 1; i < pts.length; i++) cumul.push(cumul[i - 1] + distKm(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    return { pts, cumul, longueur: cumul[cumul.length - 1] };
  }
  // Où en est-on sur le chemin ? Distance cumulée du point du chemin le plus proche (projection sur chaque segment).
  function abscisse(ch, lat, lon) {
    let meilleur = Infinity, s = 0;
    for (let i = 0; i < ch.pts.length - 1; i++) {
      const [a1, o1] = ch.pts[i], [a2, o2] = ch.pts[i + 1], L = ch.cumul[i + 1] - ch.cumul[i];
      for (let k = 0; k <= 4; k++) {                    // 5 essais par segment : précis à quelques km, assez pour une carte
        const [a, o] = grandCercle(a1, o1, a2, o2, k / 4), d = distKm(lat, lon, a, o);
        if (d < meilleur) { meilleur = d; s = ch.cumul[i] + L * k / 4; }
      }
    }
    return { s, ecart_km: meilleur };
  }
  function pointA(ch, s) {
    if (s <= 0) return ch.pts[0];
    if (s >= ch.longueur) return ch.pts[ch.pts.length - 1];
    let i = 0;
    while (ch.cumul[i + 1] < s) i++;
    const L = ch.cumul[i + 1] - ch.cumul[i];
    return grandCercle(ch.pts[i][0], ch.pts[i][1], ch.pts[i + 1][0], ch.pts[i + 1][1], L > 0 ? (s - ch.cumul[i]) / L : 0);
  }

  /* ── L'estime ────────────────────────────────────────────────────────── */
  function estimer(a, maintenant) {
    const age = maintenant - a.derniere_vue;
    const res = { lat: a.lat, lon: a.lon, age, estimee: age > FRAIS_S, mode: 'reçue', visible: true, trace: null };
    if (a.eta_utc && maintenant > a.eta_utc + APRES_ARRIVEE_S) { res.visible = false; return res; }
    if (age > 14 * 3600) { res.visible = false; return res; }
    if (!res.estimee) return res;
    const v = a.velocity_ms && a.velocity_ms > 50 ? a.velocity_ms : null;
    if (!v) { res.mode = 'immobile (vitesse inconnue)'; return res; }
    const km = v * 3.6 * age / 3600;
    const ch = a._chemin;
    if (ch) {
      if (a._s0 === undefined) a._s0 = abscisse(ch, a.lat, a.lon);   // une fois par photo : la dernière position ne bouge pas
      const { s, ecart_km } = a._s0;
      if (ecart_km < 300) {                           // l'avion est bien sur son couloir habituel
        const s2 = Math.min(s + km, ch.longueur);
        [res.lat, res.lon] = pointA(ch, s2);
        res.mode = 'à l\'estime, sur le chemin habituel de sa route';
        res.trace = [[a.lat, a.lon]];
        for (let i = 0; i < ch.pts.length; i++) if (ch.cumul[i] > s && ch.cumul[i] < s2) res.trace.push(ch.pts[i]);
        res.trace.push([res.lat, res.lon]);
        return res;
      }
    }
    if (a.arr_lat != null && a.arr_lon != null) {
      const reste = distKm(a.lat, a.lon, a.arr_lat, a.arr_lon);
      const f = reste > 0 ? Math.min(1, km / reste) : 1;
      [res.lat, res.lon] = grandCercle(a.lat, a.lon, a.arr_lat, a.arr_lon, f);
      res.mode = 'à l\'estime, trajet incertain (plus court chemin)';
      res.trace = [[a.lat, a.lon], [res.lat, res.lon]];
      return res;
    }
    res.mode = 'route inconnue : dernière position connue';
    return res;
  }

  /* ── Lecture de la photo ─────────────────────────────────────────────── */
  function versObjets(p) {
    const c = p.colonnes || [];
    return p.avions.map((ligne) => {
      const a = {};
      for (let i = 0; i < c.length; i++) a[c[i]] = ligne[i];
      a.verdict = VERDICTS.some((v) => v.cle === a.verdict_provisoire) ? a.verdict_provisoire : 'inconnu';
      const cle = `${a.dep_airport}-${a.arr_airport}`;
      a._chemin = trajets[cle] || null;
      return a;
    });
  }

  async function charger() {
    const exemple = new URLSearchParams(location.search).has('exemple');
    const url = exemple ? CFG.exemple : CFG.url;
    try {
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      photo = await r.json();
      recuLe = Number(r.headers.get('X-Photo-Recue-Le')) / 1000 || photo.genere_le;
      if (exemple) {
        // L'exemple joue « il y a 5 min » : on décale TOUTES ses heures d'autant, sinon les avions d'un exemple
        // fabriqué il y a deux jours seraient tous « arrivés » et disparaîtraient de la carte.
        const decal = (Date.now() / 1000 - 5 * 60) - photo.genere_le;
        const c = photo.colonnes || [];
        const iT = ['derniere_vue', 't_decollage', 'premier_vu', 'eta_utc'].map((n) => c.indexOf(n)).filter((i) => i >= 0);
        for (const ligne of photo.avions) for (const i of iT) if (ligne[i] != null) ligne[i] += decal;
        photo.genere_le = recuLe = photo.genere_le + decal;
      }
      avions = versObjets(photo);
      remplirRecherche();
      majStatut();
      majLegende();
      dessiner();
    } catch (e) {
      document.getElementById('statut').textContent = photo ? 'Mise à jour impossible : photo précédente gardée' : `Photo indisponible (${e.message})`;
      if (!photo) majLegende();
      document.getElementById('statut').classList.add('vieux');
    }
  }

  async function chargerTrajets() {
    try {
      const exemple = new URLSearchParams(location.search).has('exemple');
      const r = await fetch(exemple ? CFG.trajectoires_exemple : CFG.trajectoires);
      if (!r.ok) return;
      const j = await r.json();
      for (const [cle, t] of Object.entries(j.routes || {})) trajets[cle] = preparerChemin(t.pts);
    } catch (e) { /* sans chemins habituels, les avions vont au plus court : la page reste utilisable */ }
  }

  /* ── Affichage ───────────────────────────────────────────────────────── */
  const couleur = (cle) => getComputedStyle(document.documentElement).getPropertyValue(VERDICTS.find((v) => v.cle === cle).couleur).trim();
  const heure = (t) => new Date(t * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  function duree(s) {
    if (s == null) return '—';
    const m = Math.round(Math.abs(s) / 60), h = Math.floor(m / 60);
    return h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
  }

  function majStatut() {
    const el = document.getElementById('statut');
    if (!recuLe) return;
    const age = Date.now() / 1000 - recuLe;
    const n = avions.length;
    el.textContent = `Photo de ${heure(recuLe)} (il y a ${duree(age)}) · ${n.toLocaleString('fr-FR')} avions${new URLSearchParams(location.search).has('exemple') ? ' · données d\'exemple' : ''}`;
    el.classList.toggle('vieux', age > 40 * 60);
  }

  function majLegende() {
    const comptes = {};
    for (const a of avions) comptes[a.verdict] = (comptes[a.verdict] || 0) + 1;
    document.getElementById('legende').innerHTML = VERDICTS.map((v) => `
      <li><label><input type="checkbox" data-verdict="${v.cle}" ${visibles.has(v.cle) ? 'checked' : ''}>
      <span class="pastille" style="background:var(${v.couleur})" aria-hidden="true"></span>${v.nom}
      <span class="compte">${(comptes[v.cle] || 0).toLocaleString('fr-FR')}</span></label></li>`).join('');
  }

  function dessiner() {
    if (!ctx) return;
    const maintenant = Date.now() / 1000;
    const r = carte.getContainer().getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    const couleurs = Object.fromEntries(VERDICTS.map((v) => [v.cle, couleur(v.cle)]));
    for (const a of avions) {
      if (!visibles.has(a.verdict)) { a._p = null; continue; }
      const e = estimer(a, maintenant);
      a._e = e;
      if (!e.visible) { a._p = null; continue; }
      const p = carte.latLngToContainerPoint([e.lat, e.lon]);
      a._p = p;
      if (p.x < -10 || p.y < -10 || p.x > r.width + 10 || p.y > r.height + 10) continue;
      ctx.globalAlpha = e.estimee ? 0.45 : 0.95;
      ctx.fillStyle = couleurs[a.verdict];
      ctx.beginPath(); ctx.arc(p.x, p.y, a === choisi ? 6 : 3.2, 0, 2 * Math.PI); ctx.fill();
      if (e.estimee) { ctx.globalAlpha = 0.7; ctx.strokeStyle = couleurs[a.verdict]; ctx.lineWidth = 1; ctx.setLineDash([2, 2]); ctx.stroke(); ctx.setLineDash([]); }
    }
    ctx.globalAlpha = 1;
    if (choisi && choisi._e && choisi._e.visible) dessinerChoisi(choisi, couleurs[choisi.verdict]);
  }

  function dessinerChoisi(a, c) {
    const e = a._e;
    ctx.strokeStyle = c; ctx.lineWidth = 2;
    if (e.trace) {                                     // le trajet supposé depuis la dernière position reçue
      ctx.setLineDash([6, 5]); ctx.beginPath();
      e.trace.forEach(([la, lo], i) => { const p = carte.latLngToContainerPoint([la, lo]); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
      ctx.stroke(); ctx.setLineDash([]);
      const p0 = carte.latLngToContainerPoint([a.lat, a.lon]);
      ctx.beginPath(); ctx.arc(p0.x, p0.y, 3, 0, 2 * Math.PI); ctx.stroke();
    }
    if (a.arr_lat != null) {                           // la suite du voyage, en léger
      ctx.globalAlpha = 0.35; ctx.lineWidth = 1.5; ctx.beginPath();
      let reste = [];
      if (a._chemin && a._s0 && a._s0.ecart_km < 300) {
        const sE = Math.min(a._s0.s + (a.velocity_ms || 0) * 3.6 * e.age / 3600, a._chemin.longueur);
        reste = a._chemin.pts.filter((pt, i) => a._chemin.cumul[i] > sE);
      }
      [[e.lat, e.lon], ...reste, [a.arr_lat, a.arr_lon]].forEach(([la, lo], i) => {
        const p = carte.latLngToContainerPoint([la, lo]); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  function afficherFiche(a) {
    const f = document.getElementById('fiche');
    if (!a) { f.hidden = true; return; }
    const e = a._e || estimer(a, Date.now() / 1000);
    const v = VERDICTS.find((x) => x.cle === a.verdict);
    document.getElementById('fiche-titre').textContent = a.callsign || a.icao24;
    const lignes = [
      ['Route', a.dep_airport && a.arr_airport ? `${a.dep_airport} → ${a.arr_airport}` : 'inconnue'],
      ['Avion', [a.aircraft_type, a.icao24].filter(Boolean).join(' · ')],
      ['Verdict', `<span class="verdict" style="color:var(${v.couleur})">${v.nom}</span>`],
      ['Durée affichée', duree(a.duree_affichee_s)],
      ['Arrivée estimée', a.eta_utc ? heure(a.eta_utc) : '—'],
      ['Altitude', a.altitude_m != null ? `${Math.round(a.altitude_m).toLocaleString('fr-FR')} m` : '—'],
      ['Vitesse sol', a.velocity_ms != null ? `${Math.round(a.velocity_ms * 3.6)} km/h` : '—'],
      ['Dernière position', `il y a ${duree(e.age)}`],
    ];
    document.getElementById('fiche-details').innerHTML = lignes.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('');
    document.getElementById('fiche-note').textContent = e.estimee ? `Position ${e.mode}, estimée depuis ${duree(e.age)}.` : 'Position reçue à la dernière photo.';
    f.hidden = false;
  }

  function remplirRecherche() {
    document.getElementById('liste-indicatifs').innerHTML =
      avions.filter((a) => a.callsign).slice(0, 5000).map((a) => `<option value="${a.callsign}">`).join('');
  }

  function choisir(a, centrer) {
    choisi = a;
    afficherFiche(a);
    if (a && centrer) { const e = estimer(a, Date.now() / 1000); carte.setView([e.lat, e.lon], Math.max(carte.getZoom(), 6)); }
    dessiner();
  }

  /* ── La carte ────────────────────────────────────────────────────────── */
  function creerCarte() {
    carte = L.map('carte', { zoomControl: true, worldCopyJump: true, minZoom: 2 }).setView([46, 5], 4);
    carte.attributionControl.setPrefix(false);
    carte.attributionControl.addAttribution('Fond : Natural Earth · positions : ADSB.lol (ODbL)');
    fetch('vendor/fond_carte.json').then((r) => r.json()).then((fond) => {
      const rendu = L.canvas({ padding: 0.5 });
      const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
      L.geoJSON(fond.terre, { style: () => ({ renderer: rendu, interactive: false, fillColor: css('--terre'), fillOpacity: 1, stroke: false }) }).addTo(carte);
      L.geoJSON(fond.frontieres, { style: () => ({ renderer: rendu, interactive: false, color: css('--limite'), weight: 1, fill: false }) }).addTo(carte);
    }).catch(() => {});

    calque = document.createElement('canvas');
    Object.assign(calque.style, { position: 'absolute', inset: '0', zIndex: 450, pointerEvents: 'none' });
    carte.getContainer().appendChild(calque);
    ctx = calque.getContext('2d');
    const taille = () => {
      const r = carte.getContainer().getBoundingClientRect(), p = devicePixelRatio || 1;
      calque.width = r.width * p; calque.height = r.height * p;
      calque.style.width = `${r.width}px`; calque.style.height = `${r.height}px`;
      ctx.setTransform(p, 0, 0, p, 0, 0);
      dessiner();
    };
    carte.on('move zoom', dessiner);
    carte.on('resize', taille);
    taille();

    carte.on('click', (ev) => {                        // le vol le plus proche du clic, à 10 px près
      let meilleur = null, d = 10;
      for (const a of avions) {
        if (!a._p) continue;
        const dd = Math.hypot(a._p.x - ev.containerPoint.x, a._p.y - ev.containerPoint.y);
        if (dd < d) { d = dd; meilleur = a; }
      }
      choisir(meilleur, false);
    });
  }

  document.addEventListener('change', (ev) => {
    const v = ev.target.dataset && ev.target.dataset.verdict;
    if (!v) return;
    ev.target.checked ? visibles.add(v) : visibles.delete(v);
    dessiner();
  });
  document.getElementById('recherche').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = document.getElementById('champ-recherche').value.trim().toUpperCase();
    const a = avions.find((x) => (x.callsign || '').toUpperCase() === q);
    if (a) choisir(a, true);
  });
  document.getElementById('champ-recherche').addEventListener('change', (ev) => {
    ev.target.form.requestSubmit();
  });

  creerCarte();
  chargerTrajets().then(charger);
  setInterval(charger, CFG.rechargement_s * 1000);
  setInterval(() => { dessiner(); if (choisi) afficherFiche(choisi); if (recuLe) majStatut(); }, CFG.animation_s * 1000);
  window.DST_ESTIMER = estimer;                         // pour les tests
})();
