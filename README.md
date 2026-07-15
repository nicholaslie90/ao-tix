# E-Tiket AO Shuttle

Web statis (GitHub Pages) untuk menampilkan semua e-tiket AO Shuttle dari email,
**terkunci password**. Data tiket **dienkripsi** sebelum disimpan, jadi walaupun repo
publik, tanpa password isinya cuma teks acak.

```
Gmail ──(Apps Script tiap 1 jam)──▶ data/tickets.enc.json (terenkripsi) ──▶ GitHub Pages
        parse → enkripsi → push                                              login → dekripsi → tampil
```

- **Enkripsi**: AES-CBC, kunci dari PBKDF2 (SHA-256, 100k iterasi). Password tidak pernah
  dikirim ke GitHub — hanya disimpan di Script Properties (privat) & diketik di browser.
- **Auto-update**: Apps Script cek Gmail tiap 1 jam (hemat kuota Apps Script);
  web auto-poll tiap 60 detik (plus tombol **Refresh**), jadi tiket baru muncul
  paling lama ~1 jam setelah email masuk — atau segera dengan tombol Refresh.

## Struktur

| File | Fungsi |
|------|--------|
| `index.html`, `assets/app.js`, `assets/style.css` | Web interface (login + tampilan) |
| `assets/crypto-js.min.js` | CryptoJS (dekripsi di browser) |
| `data/tickets.enc.json` | Data tiket terenkripsi (ditulis oleh Apps Script) |
| `apps-script/Code.gs` | Skrip ingestion (parse + enkripsi + push) |
| `apps-script/crypto-js.gs` | CryptoJS untuk Apps Script |

## Setup (sekali saja)

### 1. Repo + GitHub Pages
1. Buat repo **publik** (mis. `ao-shuttle-tickets`), push semua file ini.
2. Settings → Pages → Source: `Deploy from a branch`, branch `main` / root. Simpan.
3. Catat URL Pages, mis. `https://<username>.github.io/ao-shuttle-tickets/`.

### 2. GitHub token
1. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate.
2. Repository access: **Only select repositories** → pilih repo di atas.
3. Permissions → Repository → **Contents: Read and write**.
4. Generate & salin token (`github_pat_...`).

### 3. Google Apps Script
1. Buka [script.google.com](https://script.google.com) **dengan akun Gmail penerima tiket**
   (`nicholaslie90@gmail.com`) → New project.
2. File `Code.gs`: paste isi `apps-script/Code.gs`.
3. Tambah file baru `cryptojs.gs`: paste isi `apps-script/crypto-js.gs`.
4. Project Settings (⚙) → **Script properties** → tambah:

   | Property | Nilai |
   |----------|-------|
   | `GITHUB_TOKEN` | token dari langkah 2 |
   | `GITHUB_OWNER` | username GitHub Anda |
   | `GITHUB_REPO` | `ao-shuttle-tickets` |
   | `GITHUB_PATH` | `data/tickets.enc.json` |
   | `GITHUB_BRANCH` | `main` |
   | `TICKET_PASSWORD` | password rahasia (yang dipakai buka web) |

5. Pilih fungsi **`setup`** → Run. Authorize akses Gmail saat diminta.
   Ini backfill semua email tiket lama & push pertama kali.
6. Trigger (⏰) → Add trigger:
   - Function: `syncTickets`
   - Event source: **Time-driven** → **Hour timer** → **Every hour**.

### 4. Buka web
Buka URL Pages, masukkan `TICKET_PASSWORD`. Centang "Ingat di perangkat ini" agar tak
perlu ketik ulang di perangkat itu.

## Catatan keamanan
- Repo boleh publik: `tickets.enc.json` terenkripsi. Tanpa password tak terbaca.
- Gambar QR/barcode di-load langsung dari `generator.asmat.app` (tidak ikut dienkripsi).
- Ganti password = ubah `TICKET_PASSWORD` lalu Run `setup` sekali untuk enkripsi ulang.
- AES-CBC + PBKDF2 cukup untuk menyembunyikan dari orang iseng; bukan kriptografi tingkat militer.

## Mengubah parser
Kalau format email AO Shuttle berubah, sesuaikan fungsi `parseTicket_` dan helper
(`labelValue_`, `parsePassengers_`, `parsePriceRows_`) di `apps-script/Code.gs`.
