# Déploiement (Nginx + Node standalone)

Ce projet est une app Next.js avec des routes API server-side (`/api/submit`,
`/api/form-data`, `/api/executions/...`) qui utilisent des variables d'env
secrètes (`N8N_HOST`, `N8N_API_KEY`). Un export statique n'est donc pas
possible : il faut un process Node qui tourne en continu, avec Nginx devant
en reverse proxy (TLS, cache des assets statiques, domaine).

`next.config.ts` a `output: "standalone"` : `next build` produit un dossier
autonome (`​.next/standalone/`) qui n'embarque que les `node_modules`
réellement utilisés, au lieu de devoir copier tout `node_modules` sur le
serveur.

## 1. Prérequis serveur (Debian/Ubuntu)

```bash
sudo apt update && sudo apt upgrade -y

# Node.js (Next 16 veut Node 20+) via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node -v   # doit afficher v20.x
```

## 2. Build (en local ou en CI)

```bash
npm ci
npm run build
```

## 3. Transfert vers le serveur

⚠️ **Piège à éviter** : `.next/standalone/.next/` est un dossier **caché**.
Si vous copiez avec un glob shell du type `.next/standalone/* → serveur`, le
`*` ne matche pas les fichiers/dossiers cachés et `.next/` sera silencieusement
ignoré — le serveur démarrera avec `server.js` présent mais sans runtime, et
plantera avec `Could not find a production build in the './.next' directory`.

Toujours cibler explicitement les dossiers avec un `/` final (rsync avec un
nom de dossier explicite inclut les fichiers cachés, contrairement à un glob
`*`) :

```bash
rsync -avz .next/standalone/ user@serveur:/var/www/portal/
rsync -avz .next/static/     user@serveur:/var/www/portal/.next/static/
rsync -avz public/           user@serveur:/var/www/portal/public/
```

Sur le serveur, `/var/www/portal/` doit ressembler à :

```
server.js
.next/
  BUILD_ID
  server/...
  static/...
node_modules/...
public/...
package.json
```

Vérification rapide après transfert :

```bash
ls /var/www/portal/.next/BUILD_ID   # doit exister
```

## 4. Variables d'environnement

Sur le serveur, créer `/var/www/portal/.env` (ou `.env.local`) avec les
mêmes clés que `.env.local.example` du repo : `N8N_HOST`, `N8N_API_KEY`, et
les éventuels `N8N_WEBHOOK_*`. Le `server.js` standalone charge `.env`/
`.env.local` automatiquement au démarrage.

## 5. Service systemd

`/etc/systemd/system/portal.service` :

```ini
[Unit]
Description=Portail N8N (Next.js standalone)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/portal
Environment=PORT=3000
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data:www-data /var/www/portal
sudo systemctl daemon-reload
sudo systemctl enable --now portal
sudo systemctl status portal
```

## 6. Nginx (reverse proxy)

```bash
sudo apt install -y nginx
```

`/etc/nginx/sites-available/portal` :

```nginx
server {
    listen 80;
    server_name votre-domaine.com;

    # Assets statiques : cache long, servis directement par nginx.
    # Le préfixe /rol/ reflète basePath/assetPrefix dans next.config.ts —
    # à adapter si cette valeur change.
    location /rol/_next/static/ {
        alias /var/www/portal/.next/static/;
        expires 365d;
        access_log off;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 7. HTTPS avec Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d votre-domaine.com
```

Certbot édite la conf Nginx pour ajouter TLS + le renouvellement auto
(`certbot.timer`).

## 8. Pare-feu

```bash
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw enable
```

## 9. Vérification

```bash
curl -I http://127.0.0.1:3000        # le process Node répond ?
sudo journalctl -u portal -f         # logs du service
curl -I https://votre-domaine.com    # via nginx/TLS
```

## 10. Mise à jour (déploiements suivants)

```bash
npm run build
rsync -avz .next/standalone/ user@serveur:/var/www/portal/
rsync -avz .next/static/     user@serveur:/var/www/portal/.next/static/
rsync -avz public/           user@serveur:/var/www/portal/public/
ssh user@serveur "sudo systemctl restart portal"
```

Nginx n'a rien à recharger sauf si sa propre config change.

## Dépannage

**`Could not find a production build in the './.next' directory`**
→ Le dossier `.next/` (caché) n'a pas été transféré — voir l'avertissement
de l'étape 3. Vérifier `ls /var/www/portal/.next/BUILD_ID`.

**La page charge sans styles/JS**
→ `.next/static/` n'a pas été copié à côté de `.next/` sur le serveur (le
standalone ne l'embarque pas automatiquement).
