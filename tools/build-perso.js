// Génère la copie « perso » de l'app (chacun saisit son propre Client ID Spotify).
// Elle réutilise app.js / style.css / icônes de la racine : relancer ce script
// après toute modification de index.html.   node tools/build-perso.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..'), out = path.join(root, 'perso');
fs.mkdirSync(out, { recursive: true });

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
html = html
  .replace('<title>iPod Spotify</title>', '<title>iPod Spotify perso</title>')
  .replace(/href="(style\.css|icons\/)/g, 'href="../$1')
  .replace(/src="app.js/, 'src="../app.js');
if (!html.includes('../app.js') || !html.includes('../style.css')) throw new Error('index.html : chemins introuvables');
fs.writeFileSync(path.join(out, 'index.html'), html);

fs.writeFileSync(path.join(out, 'config.js'), `// Copie « perso » : pas de Client ID intégré.
// Au premier lancement, l'app demande le Client ID de TON app Spotify Developer.
window.IPOD_CONFIG = {
  clientId: "",
  storageKey: "ipodperso",
  swPath: "../sw.js"
};
`);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
manifest.name = 'iPod Spotify perso';
manifest.icons = manifest.icons.map((i) => ({ ...i, src: '../' + i.src }));
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');
console.log('Copie perso générée dans', out);
