# Panduan Menjalankan Workspace RcRouter (Production)

Dokumen ini berisi panduan resmi dan operasional untuk mem-build, mendeploy, dan menjalankan aplikasi `RcRouter` dalam lingkungan production menggunakan **PM2**, **Nginx**, maupun **Docker**, serta daftar fitur kustom yang wajib dipertahankan saat sinkronisasi upstream.

---

## 1. Konfigurasi Environment

Pastikan file `.env` di root project sudah dikonfigurasi dengan benar:
```bash
# Contoh .env
PORT=20128
DATA_DIR=/home/user/.rcrouter
NODE_ENV=production
```

- Port default production `RcRouter` adalah **20128** (dapat dioverride via env `PORT`, misalnya `PORT=3003` untuk integrasi Nginx reverse proxy).
- Direktori data default berada di `~/.rcrouter` (dengan backward-compatibility dual-directory persistence dari `~/.9router`).

---

## 2. Build Aplikasi Production

Aplikasi ini menggunakan mode output Next.js `standalone` yang diproses secara otomatis via script cross-platform `scripts/build.js`:

```bash
pnpm run build
```

Script build ini secara otomatis:
1. **Melakukan safety backup database SQLite** ke `~/.rcrouter/db/backups/pre-build-<timestamp>.sqlite` sebelum `.next/` dibersihkan.
2. Menjalankan linter `no-undef`.
3. Membangun output standalone Next.js dengan Webpack.
4. Menyalin aset statis (`public/` dan `.next/static/`) ke `.next/standalone/`.
5. Memperbaiki symlink Windows jika berjalan pada platform Win32.
6. Membuat shim `localDb.js` dan ESM `package.json` untuk instrumentation hook dan runtime MITM server.

---

## 3. Menjalankan dengan PM2

Gunakan file wrapper `server.js` di root project untuk menjalankan `RcRouter` dengan PM2:

```bash
# Menjalankan instance baru pada port default (20128)
pm2 start server.js --name rcrouter

# Atau menjalankan dengan port kustom untuk upstream Nginx (misalnya port 3003)
PORT=3003 pm2 start server.js --name rcrouter

# Restart dengan update environment variables
PORT=3003 pm2 restart rcrouter --update-env

# Simpan status PM2 agar berjalan otomatis saat server reboot
pm2 save
```

---

## 4. Konfigurasi Reverse Proxy Nginx

Contoh konfigurasi Nginx reverse proxy untuk `RcRouter`:

```nginx
server {
    listen 80;
    server_name router.example.com;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:20128; # sesuaikan jika PORT=3003
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Mendukung Server-Sent Events (SSE) streaming
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

---

## 5. Menjalankan dengan Docker

`RcRouter` menyertakan Dockerfile dan entrypoint produksi `custom-server.js`:

```bash
# Build image
docker build -t rcrouter:latest .

# Jalankan container dengan persistent volume
docker run -d \
  --name rcrouter \
  -p 20128:20128 \
  -v rcrouter-data:/root/.rcrouter \
  --restart unless-stopped \
  rcrouter:latest
```

---

## 6. Troubleshooting

- **502 Bad Gateway:**
  Pastikan port pada PM2 (`pm2 env rcrouter | grep PORT`) sesuai dengan port upstream di blok `proxy_pass` Nginx.
- **Ikon atau CSS Hilang / 404 pada Static Assets:**
  Pastikan proses build dijalankan via `pnpm run build` (`scripts/build.js`), yang secara otomatis menyalin `public/` dan `.next/static` ke dalam `.next/standalone/`.
- **Database Backup Sebelum Build:**
  Backup otomatis tersimpan di `$DATA_DIR/db/backups/pre-build-*.sqlite`. Jika perlu restore manual:
  ```bash
  cp ~/.rcrouter/db/backups/pre-build-<timestamp>.sqlite ~/.rcrouter/db/data.sqlite
  ```

---

## 7. Fitur Kustom RcRouter Wajib Dijaga Saat Sync Upstream

Daftar fitur berikut **wajib diverifikasi** setiap kali melakukan cherry-pick atau merge dari upstream:

| # | Fitur | File / Lokasi | Deskripsi |
|---|---|---|---|
| 1 | **Combo P2C Strategy** | `open-sse/services/combo.js` | Power of Two Choices load balancing dengan active request counters & circuit breaker health |
| 2 | **Combo Reset-Aware Strategy** | `open-sse/services/combo.js` | Prioritasi kuota bulanan gratis yang akan reset dalam < 48 jam |
| 3 | **Combo Per-Target Timeout** | `open-sse/services/combo.js`, `src/sse/handlers/chat.js` | Dukungan `targetTimeoutMs` pada target combo individual dan combo level |
| 4 | **Combo UI Strategy Options** | `src/app/(dashboard)/dashboard/combos/page.js` | Opsi dropdown `p2c` dan `reset-aware` pada combo dashboard |
| 5 | **Ponytail Token Saver Mode** | `open-sse/rtk/ponytail.js`, `src/sse/handlers/chat.js` | Kompresi prompt agresif YAGNI untuk menghemat konsumsi token |
| 6 | **Caveman Token Saver Mode** | `open-sse/rtk/caveman.js`, `src/sse/handlers/chat.js` | Mode jawaban ringkas / padat untuk menghemat token output |
| 7 | **Tristate ACL Enforcement** | `src/sse/services/auth.js` | ACL filter untuk kind, provider, model, dan combo (`isKindAllowed`, `isProviderAllowed`, `isComboAllowed`) |
| 8 | **Trusted Internal Call Bypass** | `src/sse/services/auth.js` | Bypass otentikasi untuk panggilan internal terpercaya (`isTrustedInternalRequest`) |
| 9 | **TPS Caching & Circuit Breaker** | `open-sse/utils/circuitBreaker.js`, `src/sse/handlers/chat.js` | Circuit breaker in-memory terisolasi per `provider:proxyHash` |
| 10 | **Kimi LoopGuard & Sanitizer** | `open-sse/executors/kimi.js` | Deteksi loop infinite tool-call dan sanitasi thinking blocks pada streaming |
| 11 | **Specialized Provider: ZCode** | `open-sse/providers/registry/zcode.js`, `open-sse/executors/zcode.js` | Provider dan executor lokal ZCode |
| 12 | **Specialized Search: SearXNG** | `open-sse/config/runtimeConfig.js`, `src/sse/handlers/search.js` | Integrasi web search engine mandiri SearXNG |
| 13 | **Connection Proxy Layer** | `src/lib/network/connectionProxy.js`, `src/sse/services/auth.js` | Proxy pool selection (`pickProxyPoolId`) dan routing proxy |
| 14 | **Dual-Directory Persistence** | `src/lib/dataDir.js` | `APP_NAME = "rcrouter"`, fallback `~/.rcrouter` dan auto-migrasi dari `~/.9router` |
| 15 | **Automated Standalone Build** | `scripts/build.js`, `scripts/fix-standalone-symlinks.cjs` | Backup database, copy asset static, dan shim localDb/package.json |
| 16 | **Dynamic Port Server Wrapper** | `server.js` | Entrypoint production PM2 dengan default port 20128 dan dukungan override `PORT` |

---

## 8. Verifikasi Pasca-Merge

Setelah melakukan merge atau modifikasi:

```bash
# 1. Cek sintaks seluruh file terpengaruh
node --check server.js
node --check scripts/build.js
node --check open-sse/services/combo.js
node --check src/sse/handlers/chat.js

# 2. Jalankan test suite
pnpm test

# 3. Jalankan build produksi
pnpm run build

# 4. Verifikasi server standalone dapat diinisialisasi
node server.js &
SERVER_PID=$!
sleep 3
kill $SERVER_PID
```
