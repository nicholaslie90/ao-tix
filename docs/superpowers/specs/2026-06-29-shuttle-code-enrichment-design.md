# Enrichment Kode Shuttle (AOLV) untuk E-Tiket AO Shuttle

**Tanggal:** 2026-06-29
**Status:** Disetujui (menunggu review spec)

## Tujuan

Menampilkan **kode shuttle / armada** (format `AOLV021`–`AOLV025`, dst.) di web app e-tiket
(`ao-tix`). Kode ini tidak ada di email tiket yang selama ini di-parse — hanya tersedia di API
internal app AO Shuttle (`/reservasi/detail`, field `kode_kendaraan_pergi` / `kode_kendaraan_pulang`),
dan baru terisi setelah armada di-assign menjelang keberangkatan.

Google Apps Script (`apps-script/Code.gs`) yang sudah berjalan **tiap jam** terhadap inbox Gmail
penerima tiket akan diperluas untuk memanggil API tersebut dan menyuntikkan kode shuttle ke data
tiket sebelum dienkripsi & di-push ke GitHub. Web app lalu menampilkannya bila ada.

## Temuan reverse-engineering (sumber: `/Users/nic/Github/ao-shuttle-decompiler`)

- Endpoint detail: `POST {API_BASE}/api-whitelabel/reservasi/detail`
  - Body form-urlencoded: `kodebooking=<KODE_BOOKING>` (**tanpa underscore** — `kode_booking` gagal "TIDAK DITEMUKAN").
  - Header: `Authorization: Bearer <access_token>`.
  - Response: `{"tiketux":{"status":"OK","result":{ ... }}}`. Field relevan:
    `kode_booking`, `kode_kendaraan_pergi`, `kode_kendaraan_pulang`, `status`, `status_trip`,
    `tgl_berangkat_pergi`, `jam_berangkat_pergi`, `nomor_polisi_pergi`, `nama_sopir_pergi`, dst.
  - Untuk trip `status_trip = "MENDATANG"` yang armadanya belum di-assign, `kode_kendaraan_*` = `null`/`""`.
- Token: `POST {TOKEN_BASE}/client_token.php`, body `grant_type=client_credentials&client_id=…&client_secret=…`
  (lihat `getToken()` di `blutter-out/asm/asmat_services/services/reservasi/reservasi_II_services.dart`).
  Ini grant **client_credentials** → tidak butuh OTP, token bisa di-mint otomatis.
- `client_id`, `client_secret`, `base_host_api` **tidak hardcoded** di APK — datang dari Firebase
  Remote Config saat runtime lalu disimpan di SharedPreferences (key: `client_id`, `client_secret`,
  `base_host_api`). Harus ditangkap sekali (lihat Setup).
- `/reservasi/list` (daftar semua booking) sedang bermasalah di server (503/timeout) per Juni 2026 —
  dikonfirmasi CS. Karena itu enrichment memakai `/reservasi/detail` per kode booking, bukan `/list`.

## Arsitektur & alur data

```
[1x setup]  Tangkap client_id, client_secret, base_host_api  ──▶  Script Properties
                                                                      │
[tiap jam]  syncTickets()                                             │
   ├─ collectTickets_()  → parse email seperti biasa                  │
   ├─ enrichShuttleCodes_(tickets)                                    ▼
   │     ├─ getAoToken_()  POST {TOKEN_BASE}/client_token.php (client_credentials) → access_token (cache 1×/run)
   │     └─ untuk tiap booking DALAM JENDELA & belum ada kodenya:
   │           POST {API_BASE}/api-whitelabel/reservasi/detail  body kodebooking=…
   │           → set t.shuttleCodePergi / t.shuttleCodePulang
   ├─ hash(tickets)  → kalau berubah → enkripsi → push GitHub
   └─ (creds belum di-set / API gagal → enrichment dilewati, sync email tetap jalan)

[web app]  app.js menampilkan "Shuttle: AOLV0xx" di kartu/detail bila ada
```

**Prinsip:** enrichment bersifat *additive* dan *fail-safe*. Kalau token gagal, API down, atau creds
belum diisi, perilaku script kembali persis seperti sekarang (kode shuttle hanya kosong). Tidak ada
jalur yang bisa merusak sync email yang sudah berjalan.

## Komponen

### a. Setup sekali — tangkap kredensial
Ambil `client_id`, `client_secret`, `base_host_api` (host untuk `/client_token.php`) dan konfirmasi
`API_BASE` (host `/api-whitelabel/...`). Metode: dump SharedPreferences emulator via `adb`
(`shared_prefs/*.xml`), atau mitmproxy menangkap request `/client_token.php`. Simpan sebagai Script
Properties: `AOSHUTTLE_CLIENT_ID`, `AOSHUTTLE_CLIENT_SECRET`, `AOSHUTTLE_TOKEN_BASE`, `AOSHUTTLE_API_BASE`.

### b. `get_booking_detail.sh` (di `ao-shuttle-decompiler`, sebelah `get_my_bookings.sh`)
Input: satu kode booking. Mint token sendiri via client_credentials lalu `POST /reservasi/detail`,
cetak kode shuttle + plat + sopir + status + tanggal. Untuk cek manual.

### c. `apps-script/Code.gs` — tambah fungsi
- `getAoToken_()` → mint & cache access_token (1× per run).
- `fetchShuttleCode_(bookingCode, token)` → `{pergi, pulang}` dari response detail.
- `enrichShuttleCodes_(tickets)` → loop booking dalam jendela, set `shuttleCodePergi`/`shuttleCodePulang`.
- Dipanggil di `syncTickets` **sebelum** hashing.

### d. Web app (`assets/app.js`, opsional `assets/style.css`)
Tampilkan badge/baris "Shuttle: AOLV0xx" di kartu dan/atau detail tiket bila
`shuttleCodePergi`/`shuttleCodePulang` ada.

## Keputusan detail

- **Jendela enrich:** `departISO` antara `now − 24 jam` dan `now + 48 jam` (konstanta `ENRICH_WINDOW_*`, mudah diubah).
- **Field data tiket:** `shuttleCodePergi`, `shuttleCodePulang` (camelCase, konsisten dgn model ao-tix).
  Diisi hanya bila API mengembalikan nilai non-kosong; selain itu field tidak ditambahkan / dikosongkan.
- **Kunci pencocokan:** `kodebooking = t.bookingCode` (kode dari email `class="kode"` = `kode_booking` API; sudah diverifikasi dgn `BAOS2605300P1Z`).
- **Gating:** bila salah satu dari 4 Script Properties creds kosong → `enrichShuttleCodes_` langsung return.

## Error handling

- Token mint gagal (non-200 / tidak ada `access_token`) → skip enrichment seluruh run, `Logger.log`, sync email lanjut.
- Detail per-booking gagal/timeout → `muteHttpExceptions` + `try/catch` per booking, skip booking itu, lanjut.
- Hash dihitung **setelah** enrichment → commit hanya saat kode shuttle berubah; tidak ada commit sampah saat nilai tetap kosong.

## Testing

- `get_booking_detail.sh` diuji dengan kode booking asli (`/reservasi/detail` sudah terbukti 200 "BERHASIL!").
- `getAoToken_` (client_credentials) diuji sekali setelah creds ditangkap.
- `Code.gs` diverifikasi lewat satu run manual (`syncTickets`), cek log & hasil push.
- Web app: cek tampilan badge dengan data tiket yang punya & tidak punya kode shuttle.

## Di luar lingkup (YAGNI)

- Tidak menarik plat/sopir/manifest/tracking ke web app (hanya kode shuttle).
- Tidak memperbaiki/menggunakan `/reservasi/list`.
- Tidak mengotomasi login OTP (tidak perlu — pakai client_credentials).
