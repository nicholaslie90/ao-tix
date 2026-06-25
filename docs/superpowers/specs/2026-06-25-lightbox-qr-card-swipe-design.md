# Lightbox QR: card boarding-pass + swipe ala Tinder

## Tujuan
Membuat tampilan QR besar di lightbox menyerupai sebuah card boarding-pass, dan
membuat perpindahan antar QR penumpang terasa seperti menggeser kartu di Tinder:
card mengikuti jari saat di-drag, terlempar keluar lalu card berikutnya masuk,
dengan efek pegas balik bila geseran kurang jauh.

## Keadaan saat ini
- `index.html`: `#lightbox` berisi `<figure class="lightbox-fig">` dengan satu
  `<img id="lightbox-img">` dan `<figcaption id="lightbox-cap">` (teks melayang
  di bawah QR di atas backdrop gelap).
- `assets/app.js`: `lbItems[]` + `lbIndex`, `renderLightbox()` mengganti `src`
  dan isi caption secara instan. Navigasi via tombol ‹ ›, panah keyboard, dan
  touch-swipe sederhana (`lbStep`) tanpa animasi.
- `assets/style.css`: QR adalah `<img>` putih ber-`border-radius` di atas
  backdrop; caption teks putih.

## Rancangan

### 1. Card boarding-pass
- `<figure class="lightbox-fig">` menjadi satu card putih: sudut membulat,
  bayangan (`box-shadow`), padding.
- Susunan vertikal di DALAM card: QR di atas → garis pemisah tipis → nama →
  `Kursi <n>` → `<tanggal · jam>`.
- `renderLightbox()` mengisi QR (`src`) dan blok caption di dalam card (logika
  isi caption sama seperti sekarang: name / seat / when).

### 2. Interaksi swipe (single-element)
Hanya satu elemen card yang dianimasikan (bukan tumpukan kartu di belakang).
- **Drag** (Pointer Events, jalan di sentuh + mouse): `pointerdown` di card mulai
  drag; `pointermove` menggeser card `translateX(dx)` + `rotate(dx * k)` kecil,
  opsional sedikit menurunkan opacity saat makin jauh.
- **`pointerup`**:
  - Bila `|dx| > AMBANG` **dan** `lbItems.length > 1`: card melaju keluar ke arah
    swipe (transition translateX off-screen + rotate + fade), `transitionend`
    → `renderLightbox()` untuk index baru → card di-posisikan di sisi seberang
    (tanpa transition) → frame berikutnya transition kembali ke tengah.
  - Selain itu (geseran kurang jauh **atau** hanya satu card): **pegas balik** ke
    `translateX(0)` dengan transisi ber-easing sedikit elastis.
- Arah: swipe kiri = next, swipe kanan = prev (konsisten dengan perilaku tombol).

### 3. Tombol & keyboard
- Tombol ‹ ›, panah Left/Right, tombol ×, dan tap backdrop tetap berfungsi.
- ‹ › dan panah memicu animasi slide yang sama (out lalu in) tanpa fase drag,
  lewat fungsi bersama.

### 4. Reduced motion
- Bila `prefers-reduced-motion: reduce`, lewati animasi: ganti card secara instan
  (drag boleh tetap mengikuti tapi tanpa transisi fling/spring), supaya aksesibel.

## Komponen / pembagian
- `renderLightbox(index)` — isi card untuk satu index (tanpa animasi).
- `lbAnimateTo(delta)` — animasikan keluar+masuk untuk tombol/keyboard.
- Handler pointer (down/move/up) — drag-follow + keputusan fling/spring.
- CSS: `.lightbox-card` (gaya card), kelas/inline transform untuk transisi.

## Di luar lingkup
- Tumpukan kartu (stacked deck) di belakang — sengaja tidak dipakai.
- Perubahan pada grid QR di dalam modal detail (`pax-grid`).

## Berkas
- `index.html` — ubah struktur figure → card (QR + caption di dalam).
- `assets/style.css` — gaya `.lightbox-card`, transisi, reduced-motion.
- `assets/app.js` — drag pointer, animasi fling/spring/slide, render card.
