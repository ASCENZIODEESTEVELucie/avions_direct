// Réglages de la carte en direct. L'adresse du Worker est déjà la bonne (proud-lulu-55c4).
window.DST_DIRECT = {
  // L'adresse du Worker Cloudflare (affichée par « wrangler deploy »), suivie de /direct.
  url: 'https://proud-lulu-55c4.ascenziodeestevelucie.workers.dev/direct',
  // Les chemins habituels de chaque route (notebook 07 quater) : à copier à côté de cette page.
  trajectoires: 'trajectoires_habituelles.json',
  // Une photo d'exemple, pour essayer la page sans Worker : ajouter ?exemple à l'adresse.
  exemple: 'exemple_direct.json',
  trajectoires_exemple: 'trajectoires_exemple.json',
  rechargement_s: 120,     // la page relit la photo toutes les 2 min (le Worker la garde 60 s)
  animation_s: 2,          // les avions avancent à l'estime toutes les 2 s
};
