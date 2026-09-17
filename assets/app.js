'use strict';

/* ===== Konfigurasi ===== */
// Ambil data dari raw.githubusercontent (update segera setelah commit; tak perlu
// menunggu build GitHub Pages). Fallback ke file lokal kalau raw gagal.
var DATA_RAW = 'https://raw.githubusercontent.com/nicholaslie90/ao-tix/main/data/tickets.enc.json';
var DATA_LOCAL = 'data/tickets.enc.json';
// File kecil berisi tiket terdekat saja (ditulis Apps Script). Diunduh lebih
// dulu supaya QR tampil tanpa menunggu ±180 KB data lengkap.
var NEXT_RAW = 'https://raw.githubusercontent.com/nicholaslie90/ao-tix/main/data/next.enc.json';
var NEXT_LOCAL = 'data/next.enc.json';
var POLL_MS = 60000;
var STORE_KEY = 'aoshuttle_pw';
var THEME_KEY = 'aoshuttle_theme';

/* ===== State ===== */
var password = null;
var tickets = [];
var lastCipherText = null;
var pollTimer = null;
var generatedAt = null;   // waktu data dibuat Apps Script (di dalam payload)
var lastChecked = null;   // waktu terakhir web berhasil menarik file

/* ===== Elemen ===== */
var $ = function (id) { return document.getElementById(id); };
var loginEl = $('login'), appEl = $('app'), loginForm = $('login-form');
var pwInput = $('password'), rememberInput = $('remember'), loginError = $('login-error');
var statusEl = $('status');
var datepickerEl = $('datepicker');
var themeToggle = $('theme-toggle');
var upcomingEl = $('upcoming');
var returnWarnEl = $('return-warning');
var emptyEl = $('empty');
var modal = $('modal'), modalBody = $('modal-body');
var lightbox = $('lightbox'), lightboxImg = $('lightbox-img'), lightboxCap = $('lightbox-cap');
var lightboxCard = $('lightbox-card');
var lightboxPrev = $('lightbox-prev'), lightboxNext = $('lightbox-next');
var lightboxZoom = $('lightbox-zoom');

/* Sebagian kamera HP sulit fokus pada QR besar → 3 langkah ukuran tampil.
 * Hanya ukuran tampil yang berubah, isi QR-nya tetap sama. */
var LB_QR_STEPS = [['100%', 'Besar'], ['62%', 'Sedang'], ['40%', 'Kecil']];
var lbQrStep = 0;
try { lbQrStep = Math.min(LB_QR_STEPS.length - 1, Math.max(0, +localStorage.getItem('lbQrStep') || 0)); } catch (_) {}

function lbApplyQrSize() {
  lightboxImg.style.width = LB_QR_STEPS[lbQrStep][0];
  lightboxZoom.textContent = 'QR: ' + LB_QR_STEPS[lbQrStep][1];
}
function lbToggleQrSize() {
  lbQrStep = (lbQrStep + 1) % LB_QR_STEPS.length;
  try { localStorage.setItem('lbQrStep', lbQrStep); } catch (_) {}
  lbApplyQrSize();
}
lbApplyQrSize();  // pasang ukuran awal sebelum lightbox tampil → tak ada animasi saat dibuka

/* ===== Crypto (format sama persis dengan Apps Script) =====
 * PBKDF2 100.000 iterasi di CryptoJS itu JS murni: ~0,5 detik di laptop dan
 * beberapa detik di HP — ia yang menunda QR muncul, bukan unduhan datanya.
 * WebCrypto native mengerjakan hal yang sama ~20x lebih cepat dengan parameter
 * identik (tak ada keamanan yang dikurangi). CryptoJS hanya dimuat kalau
 * crypto.subtle tak ada, jadi 59 KB itu keluar dari jalur muat normal. */
function hexBytes(h) {
  h = String(h || '');
  var a = new Uint8Array(h.length >> 1);
  for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
  return a;
}
function b64Bytes(b) {
  var s = atob(String(b || '')), a = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
function parsePlain(text) {
  if (!text) throw new Error('wrong-password');
  try { return JSON.parse(text); } catch (e) { throw new Error('wrong-password'); }
}

function subtleCrypto() {
  try { return (window.crypto && window.crypto.subtle) || null; } catch (e) { return null; }
}

/* Muat CryptoJS sesuai kebutuhan (browser lama / konteks non-secure). */
function loadCryptoJs() {
  if (window.CryptoJS) return Promise.resolve();
  return new Promise(function (resolve, reject) {
    var el = document.createElement('script');
    el.src = 'assets/crypto-js.min.js';
    el.onload = resolve;
    el.onerror = function () { reject(new Error('crypto-load-failed')); };
    document.head.appendChild(el);
  });
}

function decryptWithCryptoJs(blob, pw) {
  var key = CryptoJS.PBKDF2(pw, CryptoJS.enc.Hex.parse(blob.salt), {
    keySize: 256 / 32,
    iterations: blob.iter || 100000,
    hasher: CryptoJS.algo.SHA256
  });
  var decrypted = CryptoJS.AES.decrypt(
    { ciphertext: CryptoJS.enc.Base64.parse(blob.ct) },
    key,
    { iv: CryptoJS.enc.Hex.parse(blob.iv), mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
  );
  var text;
  try { text = decrypted.toString(CryptoJS.enc.Utf8); }
  catch (e) { throw new Error('wrong-password'); }
  return parsePlain(text);
}

/* -> Promise<payload>. Password salah / blob rusak = Error('wrong-password'),
 * sama seperti versi lama, jadi penanganan error di loginForm tak berubah. */
function decryptPayload(blob, pw) {
  var sub = subtleCrypto();
  if (!sub) return loadCryptoJs().then(function () { return decryptWithCryptoJs(blob, pw); });

  return sub.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits'])
    .then(function (base) {
      return sub.deriveBits({
        name: 'PBKDF2',
        salt: hexBytes(blob.salt),
        iterations: blob.iter || 100000,
        hash: 'SHA-256'
      }, base, 256);
    })
    .then(function (bits) { return sub.importKey('raw', bits, { name: 'AES-CBC' }, false, ['decrypt']); })
    .then(function (key) { return sub.decrypt({ name: 'AES-CBC', iv: hexBytes(blob.iv) }, key, b64Bytes(blob.ct)); })
    .catch(function () { throw new Error('wrong-password'); })   // padding gagal = password salah
    .then(function (buf) { return parsePlain(new TextDecoder().decode(buf)); });
}

/* ===== Fetch + load ===== */
function fetchBlob(raw, local) {
  var bust = '?t=' + Date.now();
  return fetch((raw || DATA_RAW) + bust, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('raw'); return r.text(); })
    .catch(function () { // fallback ke file di Pages
      return fetch((local || DATA_LOCAL) + bust, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('fetch-failed-' + r.status);
        return r.text();
      });
    });
}

/* Tarik data, dekripsi, render. force=true selalu render ulang. */
function loadData(force) {
  return fetchBlob(DATA_RAW, DATA_LOCAL).then(function (raw) {
    lastChecked = Date.now(); // selalu catat waktu cek, walau data tak berubah
    if (!force && raw === lastCipherText) { updateStatus(); return false; }
    lastCipherText = raw;
    var blob = JSON.parse(raw);
    if (!blob.ct) throw new Error('not-ready'); // placeholder / belum ada data
    return decryptPayload(blob, password).then(function (data) {   // reject: wrong-password
      var openCode = openTicketIdx >= 0 && tickets[openTicketIdx]
        ? tickets[openTicketIdx].bookingCode : '';
      fullLoaded = true;
      tickets = (data.tickets || []);
      generatedAt = data.generatedAt || null;
      realignOpen(openCode);     // index lama menunjuk array fase cepat
      render();
      updateStatus();
      return true;
    });
  });
}

/* Fase cepat: unduh file kecil berisi tiket terdekat, tampilkan QR-nya, lalu
 * biarkan data lengkap menyusul di latar belakang. Resolve true kalau berhasil
 * dipakai. Kegagalan apa pun (file belum ada, password salah) dibiarkan diam —
 * fase penuh tetap berjalan dan menentukan hasil akhir. */
var fullLoaded = false;
function loadNextOnly() {
  return fetchBlob(NEXT_RAW, NEXT_LOCAL).then(function (raw) {
    var blob = JSON.parse(raw);
    if (!blob.ct) throw new Error('not-ready');
    return decryptPayload(blob, password);
  }).then(function (data) {
    // Data penuh keburu tiba: jangan timpa dengan yang cuma satu tiket.
    if (fullLoaded) return false;
    var list = data.tickets || [];
    if (!list.length) return false;
    tickets = list;
    render();
    return true;
  });
}

/* Fase cepat memakai array berisi satu tiket; begitu data penuh tiba isi
 * `tickets` berganti dan index lama tak lagi menunjuk tiket yang sama.
 * Samakan ulang lewat kode booking supaya modal/lightbox yang sedang terbuka
 * tidak salah rujuk. */
function realignOpen(code) {
  if (!code) return;
  var i = -1;
  tickets.forEach(function (t, n) { if (t.bookingCode === code) i = n; });
  if (i < 0) return;
  if (openTicketIdx >= 0) openTicketIdx = i;
  if (autoIdx >= 0) autoIdx = i;
}

/* Dua fase sekaligus: keduanya dimulai bersamaan, yang kecil hampir selalu
 * menang dan langsung memunculkan QR. */
function startLoad() {
  var full = loadData(true);
  loadNextOnly().then(function (ok) { if (ok) showApp(); }).catch(function () { /* diam */ });
  return full.then(function () {
    if (!appShown) showApp();
    else maybeAdvanceAuto();
  });
}

function updateStatus() {
  // ponytail: 3 statistik (tiket/data/dicek) dihapus; statusEl dipakai untuk pesan transien saja.
  statusEl.textContent = '';
}

/* ===== Login ===== */
var loginBtn = loginForm.querySelector('button[type="submit"]');
function loginBusy(busy) {
  loginBtn.disabled = busy;
  loginBtn.textContent = busy ? 'Membuka…' : 'Buka';
}
loginForm.addEventListener('submit', function (e) {
  e.preventDefault();
  loginError.hidden = true;
  var pw = pwInput.value;
  if (!pw) return;
  password = pw;
  loginBusy(true);
  startLoad().then(function () {
    loginBusy(false);
    if (rememberInput.checked) localStorage.setItem(STORE_KEY, pw);
    else sessionStorage.setItem(STORE_KEY, pw);
    showApp();          // no-op kalau fase cepat sudah menampilkannya
  }).catch(function (err) {
    loginBusy(false);
    password = null;
    if (String(err.message).indexOf('wrong-password') >= 0) {
      showLoginError('Password salah.');
    } else if (String(err.message).indexOf('not-ready') >= 0 ||
               String(err.message).indexOf('fetch-failed') >= 0) {
      showLoginError('Data tiket belum tersedia. Jalankan Apps Script dulu, lalu coba lagi.');
    } else {
      showLoginError('Gagal memuat: ' + err.message);
    }
  });
});

function showLoginError(msg) { loginError.textContent = msg; loginError.hidden = false; }

var appShown = false;
function showApp() {
  if (appShown) return;
  appShown = true;
  loginEl.hidden = true;
  appEl.hidden = false;
  startPolling();
  // Begitu berhasil login, langsung buka detail kartu yang paling relevan jam ini
  // dan tampilkan QR-nya dalam lightbox, seolah QR-nya sudah diketuk.
  autoOpen(ticketToAutoOpen());
}

/* Tiket yang relevan "sekarang": tiket paling awal yang belum lewat 2 jam sejak
 * berangkat. Jadi tiket berjalan tetap tampil sampai 2 jam setelah keberangkatan,
 * lalu otomatis berganti ke tiket berikutnya. null kalau tak ada. */
var ACTIVE_AFTER_DEPART_MS = 2 * 3600000;

function ticketToAutoOpen() {
  var cutoff = Date.now() - ACTIVE_AFTER_DEPART_MS;
  var best = null, bestDep = Infinity;
  tickets.forEach(function (t) {
    var dep = Date.parse(t.departISO);
    if (isNaN(dep) || dep <= cutoff) return;
    if (dep < bestDep) { bestDep = dep; best = t; }
  });
  return best;
}

/* Buka modal + lightbox tiket otomatis, dan ingat index + tanda-tangannya. */
var autoIdx = -1, autoKey = '';
function autoSig(t) { return t.departISO + '|' + shuttleText(t); }
function autoOpen(t) {
  if (!t) return;
  autoIdx = tickets.indexOf(t);
  autoKey = autoSig(t);
  openModal(t);
  openLightboxFromModal(0);
}

/* Tiap poll, dua hal bisa berubah: (1) waktu berjalan mengganti tiket "sekarang"
 * (2 jam setelah tiket berjalan berangkat), (2) data ter-poll mengisi kode shuttle
 * tiket yang sedang tampil (kode diisi menjelang berangkat). Selama lightbox
 * otomatis masih terbuka pada tiket itu, buka ulang bila tiket ATAU kode shuttle-nya
 * berubah — jadi link peta muncul tanpa perlu refresh. Tidak mengganggu kalau user
 * sudah menutup lightbox atau membuka kartu lain. */
function maybeAdvanceAuto() {
  if (lightbox.hidden || openTicketIdx !== autoIdx) return;
  var t = ticketToAutoOpen();
  if (t && autoSig(t) !== autoKey) autoOpen(t);
}

function logout() {
  password = null; tickets = []; lastCipherText = null;
  appShown = false; fullLoaded = false;
  localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY);
  stopPolling();
  appEl.hidden = true; loginEl.hidden = false;
  pwInput.value = ''; pwInput.focus();
}

/* ===== Polling ===== */
function startPolling() {
  stopPolling();
  pollTimer = setInterval(function () {
    if (!password) return;
    // maybeAdvanceAuto SETELAH data settle, supaya ia melihat kode shuttle terbaru.
    loadData(false).then(maybeAdvanceAuto).catch(function () { /* abaikan error sementara */ });
  }, POLL_MS);
}
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

/* ===== Tiket pulang belum dibeli =====
 * Tiap hari = 2 tiket: pergi (berangkat DARI rumah) + pulang (kembali KE rumah).
 * "Rumah" dideteksi otomatis: titik asal yang paling sering jadi keberangkatan
 * pertama (paling pagi) di tiap tanggal. Untuk tiap tanggal *akan datang*, kalau
 * ada pergi tapi tak ada pulang (atau sebaliknya), pasangannya ditandai kurang. */
function normPoint(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}
function dateKey(t) { return t.departISO ? t.departISO.slice(0, 10) : ''; }

function detectHome(list) {
  // Per tanggal, ambil tiket paling pagi; vote departurePoint-nya sebagai rumah.
  var earliest = {};
  list.forEach(function (t) {
    var k = dateKey(t);
    if (!k) return;
    if (!earliest[k] || t.departISO < earliest[k].departISO) earliest[k] = t;
  });
  var votes = {}, best = null, bestN = 0;
  Object.keys(earliest).forEach(function (k) {
    var p = normPoint(earliest[k].departurePoint);
    if (!p) return;
    votes[p] = (votes[p] || 0) + 1;
    if (votes[p] > bestN) { bestN = votes[p]; best = p; }
  });
  return best;
}

/* Set t._missing ('pulang' | 'pergi' | null) untuk tiket akan datang.
 * Kembalikan ringkasan tanggal yang kurang: [{type, dateLabel, departISO}]. */
function annotateMissing(list, home) {
  list.forEach(function (t) { t._missing = null; });
  if (!home) return [];
  var now = Date.now();
  // Kelengkapan hari dihitung dari SEMUA tiket tanggal itu (termasuk yang sudah
  // berangkat), supaya tiket pergi yang sudah dipakai pagi ini tetap dianggap ada.
  var groups = {};
  list.forEach(function (t) {
    var k = dateKey(t);
    if (!k) return;
    (groups[k] = groups[k] || []).push(t);
  });
  var summary = [];
  Object.keys(groups).forEach(function (k) {
    var arr = groups[k];
    var hasPergi = arr.some(function (t) { return normPoint(t.departurePoint) === home; });
    var hasPulang = arr.some(function (t) { return normPoint(t.destinationPoint) === home; });
    var type = null;
    if (hasPergi && !hasPulang) type = 'pulang';
    else if (hasPulang && !hasPergi) type = 'pergi';
    if (!type) return;
    // Badge hanya pada tiket yang BELUM berangkat (ada kartu akan datang utk ditandai).
    var repISO = null;
    arr.forEach(function (t) {
      var dep = Date.parse(t.departISO);
      if (isNaN(dep) || dep < now) return; // sudah berangkat -> jangan tandai
      var isPergi = normPoint(t.departurePoint) === home;
      if ((type === 'pulang' && isPergi) || (type === 'pergi' && !isPergi)) {
        t._missing = type;
        if (!repISO || t.departISO < repISO) repISO = t.departISO;
      }
    });
    if (repISO) summary.push({ type: type, departISO: repISO, dateLabel: fmtDateShort(repISO) });
  });
  summary.sort(function (a, b) { return a.departISO < b.departISO ? -1 : 1; });
  return summary;
}

function renderReturnWarning(summary) {
  if (!summary.length) { returnWarnEl.hidden = true; returnWarnEl.innerHTML = ''; return; }
  function line(items, kata) {
    return '⚠️ ' + items.length + ' hari belum punya tiket <strong>' + kata + '</strong>: ' +
      items.map(function (m) { return esc(m.dateLabel); }).join(', ');
  }
  var pulang = summary.filter(function (m) { return m.type === 'pulang'; });
  var pergi = summary.filter(function (m) { return m.type === 'pergi'; });
  var lines = [];
  if (pulang.length) lines.push(line(pulang, 'pulang'));
  if (pergi.length) lines.push(line(pergi, 'pergi'));
  returnWarnEl.innerHTML = lines.map(function (l) { return '<div>' + l + '</div>'; }).join('');
  returnWarnEl.hidden = false;
}

/* ===== Render ===== */
function render() {
  // Tanggal hari ini di zona WIB (YYYY-MM-DD). Tiket yang harinya sudah lewat tak
  // ditampilkan — bisa saja masih ada di file sampai sync Apps Script berikutnya.
  var todayWIB = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  var upcoming = [];

  var missing = annotateMissing(tickets, detectHome(tickets));

  tickets.forEach(function (t) {
    var day = dateKey(t);
    if (!day || day >= todayWIB) upcoming.push(t);
  });

  upcoming.sort(function (a, b) { return Date.parse(a.departISO) - Date.parse(b.departISO); });

  upcomingEl.innerHTML = dayGroupsHtml(upcoming);
  emptyEl.hidden = upcoming.length !== 0;

  renderReturnWarning(missing);
  bindCards();
}

/* Kelompokkan tiket (sudah terurut) per tanggal, beri header tanggal. */
function dayGroupsHtml(list) {
  var order = [], byKey = {};
  list.forEach(function (t) {
    var k = dateKey(t) || '(tanpa tanggal)';
    if (!byKey[k]) { byKey[k] = []; order.push(k); }
    byKey[k].push(t);
  });
  return order.map(function (k) {
    var arr = byKey[k];
    var head = esc((arr[0].departDate || k).replace(/\s*$/, ''));
    var warn = arr.some(function (t) { return t._missing; });
    return '<section class="day-group' + (warn ? ' day-warn' : '') + '" data-date="' + esc(k) + '">' +
      '<h3 class="day-head">' + head + '</h3>' +
      '<div class="cards">' + arr.map(function (t) { return cardHtml(t, true); }).join('') + '</div>' +
    '</section>';
  }).join('');
}

function cardHtml(t, hideDate) {
  var idx = tickets.indexOf(t);
  var route = esc(t.departurePoint || routeFromPax(t)) + ' → ' + esc(t.destinationPoint || '');
  var timePart = t.departTime ? '<span class="card-time">' + esc(t.departTime) + '</span>' : '';
  var when = hideDate
    ? timePart
    : (esc((t.departDate || '').replace(/\s*$/, '')) + (timePart ? ' · ' + timePart : ''));
  var pax = (t.passengers || []).length;
  return '' +
    '<article class="card' + (t._missing ? ' has-warn' : '') + '" data-idx="' + idx + '" data-date="' + esc(dateKey(t)) + '">' +
      '<div class="card-head">' +
        '<span class="card-route">' + routeCodes(t) + '</span>' +
        badge(t) +
      '</div>' +
      (t._missing ? '<div class="card-warn">⚠️ Tiket ' + t._missing + ' belum dibeli</div>' : '') +
      '<div class="card-when">' + when + '</div>' +
      '<div class="muted">' + route + '</div>' +
      '<div class="card-meta">' +
        '<span class="kode">' + esc(t.bookingCode || '') + '</span>' +
        (shuttleText(t) ? '<span class="shuttle">🚐 ' + esc(shuttleText(t)) + '</span>' : '') +
        '<span>' + pax + ' penumpang</span>' +
      '</div>' +
    '</article>';
}

function routeCodes(t) {
  var p = (t.passengers && t.passengers[0]) || (t.priceRows && t.priceRows[0]);
  if (p && p.route) return esc(p.route.replace(/\s+/g, ' '));
  return esc(t.departurePoint || '');
}
function routeFromPax(t) {
  var p = (t.passengers && t.passengers[0]);
  return p ? p.route : '';
}

/* Detail dari manifest AO (sopir, plat, estimasi tiba, urutan pemberhentian).
 * Semuanya opsional: manifest baru terbit H-1, dan sebagian field bisa kosong.
 * Baris yang datanya tak ada tidak ditampilkan sama sekali. */
function tripRows(t) {
  var rows = [];
  if (t.driverName) rows.push(['Sopir', esc(t.driverName)]);
  if (t.vehiclePlate) rows.push(['Nomor Plat', '<span class="kode">' + esc(t.vehiclePlate) + '</span>']);
  // Manifest AO kadang menyebut armada lain daripada yang tertulis di tiket.
  // Yang di manifest itu yang benar-benar jalan, jadi tampilkan apa adanya.
  if (t.tripHull) {
    rows.push(['Armada Sebenarnya', '<span class="kode">' + esc(t.tripHull) + '</span>' +
      '<span class="muted"> (tiket tertulis ' + esc(t.shuttleCodePergi || '—') + ')</span>']);
  }
  if (t.tripEta) rows.push(['Estimasi Tiba', esc(fmtTripTime(t.tripEta))]);
  if (t.tripRef) rows.push(['Kode Perjalanan', '<span class="kode">' + esc(t.tripRef) + '</span>']);
  if ((t.tripStops || []).length) rows.push(['Pemberhentian', stopsHtml(t)]);
  return rows;
}

/* Daftar pemberhentian, dengan pemberhentian NAIK dan TURUN milik tiket ini
 * ditandai. Nama outlet di manifest sama persis dengan Point Keberangkatan /
 * Point Tujuan di tiket; tetap dinormalkan supaya beda spasi tak meleset. */
function normStop(s) { return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim(); }
function stopsHtml(t) {
  var naik = normStop(t.departurePoint), turun = normStop(t.destinationPoint);
  return '<ol class="stops">' + t.tripStops.map(function (n) {
    var k = normStop(n), tag = '';
    if (k && k === naik) tag = '<span class="stop-tag stop-naik">naik</span>';
    else if (k && k === turun) tag = '<span class="stop-tag stop-turun">turun</span>';
    return '<li' + (tag ? ' class="stop-mine"' : '') + '>' + esc(n) + tag + '</li>';
  }).join('') + '</ol>';
}
/* Manifest memberi "2026-09-16 18:30" (WIB). Tampilkan jamnya saja kalau
 * tanggalnya sama dengan tanggal berangkat — selebihnya apa adanya. */
function fmtTripTime(s) {
  var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(String(s || ''));
  return m ? m[2] + ' WIB · ' + m[1] : s;
}

function shuttleCodes(t) {
  var out = [], a = t.shuttleCodePergi || '', b = t.shuttleCodePulang || '';
  if (a) out.push(a);
  if (b && b !== a) out.push(b);
  return out;
}
function shuttleText(t) { return shuttleCodes(t).join(' / '); }
/* Link lacak posisi. eta.transtrack.id yang lama sudah mati (HTTP 500).
 * Penggantinya: t.trackUrl, di-resolve backend (Code.gs) lewat endpoint
 * /getTracking milik halaman Bus Terdekat. URL itu per-perjalanan dan hanya
 * ada menjelang/selama trip; tanpa itu kodenya tampil polos tanpa link.
 * Selalu tab baru, tidak pernah iframe. Peta asmat itu SPA yang bergantung pada
 * storage; di iframe lintas-origin storage-nya dipartisi (dan Brave memblokirnya
 * sama sekali), sehingga isinya kosong/putih. Di tab sendiri ia jalan normal. */
function shuttleAnchors(codes, trackUrl) {
  return codes.map(function (c, i) {
    if (!trackUrl || i !== 0) return '<span class="kode">' + esc(c) + '</span>';   // trackUrl selalu untuk kode leg pergi
    return '<a class="kode" target="_blank" rel="noopener" href="' + esc(trackUrl) +
      '" title="Lacak posisi shuttle (tab baru)">' + esc(c) + '</a>';
  }).join(' · ');
}
function shuttleLinksHtml(t) { return shuttleAnchors(shuttleCodes(t), t.trackUrl); }
/* Trip akan datang / baru saja berangkat: kode shuttle memang diisi menjelang
 * berangkat, jadi tampilkan "belum tersedia" alih-alih menyembunyikan barisnya. */
function shuttleCodePending(t) {
  var dep = t.departISO ? Date.parse(t.departISO) : NaN;
  return !isNaN(dep) && dep >= Date.now() - 6 * 3600000;
}

function badge(t) {
  var dep = t.departISO ? Date.parse(t.departISO) : NaN;
  if (isNaN(dep)) return '<span class="badge">—</span>';
  var diff = dep - Date.now();
  if (diff < 0) return '<span class="badge">selesai</span>';
  var hours = diff / 3600000;
  if (hours <= 48) {
    var label = hours < 1 ? '<1 jam lagi'
      : (hours < 24 ? Math.round(hours) + ' jam lagi'
        : Math.round(hours / 24) + ' hari lagi');
    return '<span class="badge soon">' + label + '</span>';
  }
  return '<span class="badge">' + Math.round(hours / 24) + ' hari lagi</span>';
}

function bindCards() {
  var els = document.querySelectorAll('.card');
  for (var i = 0; i < els.length; i++) {
    els[i].addEventListener('click', function () {
      openModal(tickets[parseInt(this.getAttribute('data-idx'), 10)]);
    });
  }
}

/* ===== Modal detail ===== */
var openTicketIdx = -1;   // index tiket yang sedang ditampilkan di modal
function openModal(t) {
  if (!t) return;
  openTicketIdx = tickets.indexOf(t);
  modalBody.innerHTML = detailHtml(t);
  modal.hidden = false;
}
function closeModal() { modal.hidden = true; modalBody.innerHTML = ''; }

modal.addEventListener('click', function (e) {
  if (e.target.hasAttribute('data-close')) closeModal();
});

/* ===== Lightbox QR/barcode ===== */
var lbItems = [];   // daftar QR yang sedang dibuka: [{ src, cap }]
var lbIndex = 0;

/* PNG barcode dari AO transparan, jadi saat disimpan/di-share tampil hitam.
 * Rata-kan ke kanvas putih sekali per QR lalu tukar src-nya. */
var lbWhite = {};
function whitenQr(src, done) {
  if (lbWhite[src]) return done(lbWhite[src]);
  var im = new Image();
  im.crossOrigin = 'anonymous';                       // barcodeUrl lintas-domain: tanpa ini kanvas ternoda
  im.onload = function () {
    try {
      // Kelipatan bulat ke >=512px: modul QR tetap tajam (tanpa antialias abu-abu).
      var s = Math.max(1, Math.ceil(512 / Math.max(im.naturalWidth, im.naturalHeight)));
      var c = document.createElement('canvas');
      c.width = im.naturalWidth * s; c.height = im.naturalHeight * s;
      var g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(im, 0, 0, c.width, c.height);
      done(lbWhite[src] = c.toDataURL('image/png'));
    } catch (_) {}                                    // gagal (CORS) → biarkan src asli
  };
  im.src = src;
}

function renderLightbox() {
  var item = lbItems[lbIndex];
  if (!item) return;
  lightboxImg.src = item.src;
  whitenQr(item.src, function (url) {
    var cur = lbItems[lbIndex];
    if (cur && cur.src === item.src) lightboxImg.src = url;   // abaikan bila sudah geser kartu
  });
  // Nama di atas, lalu nomor kursi, lalu tanggal & jam keberangkatan di bawahnya.
  var capHtml = (item.name ? '<span class="lb-cap-name">' + esc(item.name) + '</span>' : '') +
    (item.shuttle ? '<span class="lb-cap-shuttle">' + shuttleAnchors(item.shuttle.split(','), item.track) + '</span>' : '') +
    (item.seat ? '<span class="lb-cap-seat">Kursi ' + esc(item.seat) + '</span>' : '') +
    (item.when ? '<span class="lb-cap-when">' + esc(item.when) + '</span>' : '');
  lightboxCap.innerHTML = capHtml;
  lightboxCap.hidden = !capHtml;
  var multi = lbItems.length > 1;
  lightboxPrev.hidden = !multi;
  lightboxNext.hidden = !multi;
}
function openLightbox(index) {
  if (!lbItems.length) return;
  lbIndex = (index + lbItems.length) % lbItems.length;
  renderLightbox();
  lbSetTransform(0, 0, 'none');   // mulai dari tengah, tanpa sisa animasi
  lbAnimating = false;
  lbApplyQrSize();
  lightbox.hidden = false;
}
function closeLightbox() { lightbox.hidden = true; lightboxImg.src = ''; lbItems = []; }

/* ---- Animasi swipe ala kartu ---- */
var lbAnimating = false;
var LB_SWIPE = 60;          // ambang geser (px) untuk pindah kartu
var LB_ROT = 0.06;          // derajat kemiringan per px geser

function lbReduce() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function lbSetTransform(x, deg, transition) {
  lightboxCard.style.transition = transition || 'none';
  lightboxCard.style.transform = 'translateX(' + x + 'px) rotate(' + deg + 'deg)';
}
function lbOnce(cb) {                       // jalankan cb sekali saat transisi transform selesai
  var done = false;
  function fire() { if (done) return; done = true; lightboxCard.removeEventListener('transitionend', fire); cb(); }
  lightboxCard.addEventListener('transitionend', fire);
}
// Pegas balik ke tengah (efek elastis ringan) — dipakai saat geseran kurang jauh / hanya 1 kartu.
function lbSpringBack() {
  if (lbReduce()) { lbSetTransform(0, 0, 'none'); return; }
  lbSetTransform(0, 0, 'transform .38s cubic-bezier(.34,1.56,.64,1)');
}
// Pindah kartu dengan animasi: kartu lama terbang keluar, kartu baru masuk dari sisi seberang.
// dir = 1 (berikutnya, terbang ke kiri) atau -1 (sebelumnya, terbang ke kanan).
function lbCommit(dir) {
  if (lbItems.length < 2) { lbSpringBack(); return; }
  if (lbAnimating) return;
  if (lbReduce()) {
    lbIndex = (lbIndex + dir + lbItems.length) % lbItems.length;
    renderLightbox();
    lbSetTransform(0, 0, 'none');
    return;
  }
  lbAnimating = true;
  var span = Math.max(window.innerWidth, 600) * 1.1;
  lbSetTransform(-dir * span, -dir * 18, 'transform .26s ease-in');   // terbang keluar
  lbOnce(function () {
    lbIndex = (lbIndex + dir + lbItems.length) % lbItems.length;
    renderLightbox();
    lbSetTransform(dir * span, dir * 18, 'none');                     // taruh di sisi seberang
    void lightboxCard.offsetWidth;                                    // paksa reflow
    lbSetTransform(0, 0, 'transform .32s cubic-bezier(.22,1,.36,1)'); // masuk ke tengah
    lbOnce(function () { lbAnimating = false; lightboxCard.style.transition = ''; });
  });
}

/* Kumpulkan semua QR di modal lalu buka lightbox pada index tertentu.
 * Dipakai saat QR diketuk maupun otomatis setelah login. */
function openLightboxFromModal(index) {
  var imgs = Array.prototype.slice.call(modalBody.querySelectorAll('img.pax-qr'));
  if (!imgs.length) return;
  lbItems = imgs.map(function (el) {
    return {
      src: el.getAttribute('src'),
      name: el.getAttribute('data-name'),
      seat: el.getAttribute('data-seat'),
      when: el.getAttribute('data-when'),
      shuttle: el.getAttribute('data-shuttle'),
      track: el.getAttribute('data-track')
    };
  });
  openLightbox(index);
}

modalBody.addEventListener('click', function (e) {
  var img = e.target.closest && e.target.closest('img.pax-qr');
  if (!img) return;
  var imgs = Array.prototype.slice.call(modalBody.querySelectorAll('img.pax-qr'));
  openLightboxFromModal(imgs.indexOf(img));
});
lightbox.addEventListener('click', function (e) {
  if (e.target.hasAttribute('data-lb-zoom')) { lbToggleQrSize(); return; }
  if (e.target.hasAttribute('data-close-lb')) { closeLightbox(); return; }
  if (e.target.hasAttribute('data-lb-prev')) { lbCommit(-1); return; }
  if (e.target.hasAttribute('data-lb-next')) { lbCommit(1); return; }
});

/* Drag kartu (sentuh + mouse) lewat Pointer Events — kartu mengikuti jari,
 * lalu terbang keluar bila digeser cukup jauh, atau pegas balik bila tidak. */
var lbDrag = null;
lightboxCard.addEventListener('pointerdown', function (e) {
  if (lbAnimating) return;
  if (e.button != null && e.button > 0) return;   // hanya tombol kiri/sentuh
  lbDrag = { x0: e.clientX, y0: e.clientY, dx: 0, active: false, id: e.pointerId };
});
lightboxCard.addEventListener('pointermove', function (e) {
  if (!lbDrag || e.pointerId !== lbDrag.id) return;
  var dx = e.clientX - lbDrag.x0, dy = e.clientY - lbDrag.y0;
  if (!lbDrag.active) {
    if (Math.abs(dx) < 6) return;                  // belum cukup untuk dianggap drag
    if (Math.abs(dy) > Math.abs(dx)) { lbDrag = null; return; }  // gerak vertikal → abaikan
    lbDrag.active = true;
    try { lightboxCard.setPointerCapture(e.pointerId); } catch (_) {}
  }
  lbDrag.dx = dx;
  lbSetTransform(dx, dx * LB_ROT, 'none');
  e.preventDefault();
});
function lbEndDrag(e) {
  if (!lbDrag || (e.pointerId != null && e.pointerId !== lbDrag.id)) return;
  var dx = lbDrag.dx, active = lbDrag.active;
  lbDrag = null;
  if (!active) return;
  if (Math.abs(dx) > LB_SWIPE && lbItems.length > 1) lbCommit(dx < 0 ? 1 : -1);
  else lbSpringBack();
}
lightboxCard.addEventListener('pointerup', lbEndDrag);
lightboxCard.addEventListener('pointercancel', lbEndDrag);

document.addEventListener('keydown', function (e) {
  if (!lightbox.hidden) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbCommit(-1);
    else if (e.key === 'ArrowRight') lbCommit(1);
    return;
  }
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

function detailHtml(t) {
  return '' +
    '<h2 class="detail-route">' + routeCodes(t) + '</h2>' +
    '<p class="detail-when">' + esc(t.departDate || '') + (t.departTime ? ' · ' + esc(t.departTime) : '') + '</p>' +

    (t._missing
      ? '<div class="banner-warn">⚠️ Tiket <strong>' + esc(t._missing) + '</strong> belum dibeli untuk tanggal ini</div>'
      : '') +

    section('Pemesanan', kv([
      ['Kode Booking', '<span class="kode">' + esc(t.bookingCode) + '</span>'],
      ['Tanggal Booking', esc(t.bookingDate)],
      ['Nama', esc(t.name)],
      ['Alamat', esc(t.address)],
      ['No. Telp', esc(t.phone)],
      ['Email', esc(t.email)],
      ['OTP', '<span class="otp">' + esc(t.otp) + '</span>'],
      ['Email diterima', t.messageDate ? esc(fmtDateTime(t.messageDate)) : '']
    ])) +

    section('Keberangkatan', kv([
      ['Dari', esc(t.departurePoint)],
      ['Alamat', esc(t.departureAddress)],
      ['Maps', mapLink(t.departureMaps)],
      ['Tujuan', esc(t.destinationPoint)],
      ['Alamat', esc(t.destinationAddress)],
      ['Maps', mapLink(t.destinationMaps)],
      ['Tanggal', esc(t.departDate)],
      ['Jam', esc(t.departTime)]
    ].concat(shuttleCodes(t).length
      ? [['Kode Shuttle', shuttleLinksHtml(t)]]
      : (shuttleCodePending(t) ? [['Kode Shuttle', '<span class="muted">belum tersedia</span>']] : [])))) +

    (tripRows(t).length ? section('Perjalanan', kv(tripRows(t))) : '') +

    section('Penumpang', (t.passengers || []).length
      ? '<div class="pax-grid">' + (t.passengers || []).map(function (p) { return paxHtml(p, t); }).join('') + '</div>'
      : '<p class="muted">—</p>') +

    section('Harga', pricesHtml(t)) +

    section('Pembayaran', kv([
      ['Metode', esc(t.paymentMethod)],
      ['Waktu', esc(t.paymentTime)]
    ]));
}

function paxHtml(p, t) {
  t = t || {};
  var when = (t.departDate || '') + (t.departTime ? ' · ' + t.departTime : '');
  var img = '';
  if (p.barcodeData || p.barcodeUrl) {
    img = '<img class="pax-qr" src="' + esc(p.barcodeData || p.barcodeUrl) + '" alt="Boarding ' + esc(p.name) +
      '" loading="lazy" data-name="' + esc(p.name || '') + '" data-seat="' + esc(p.seat || '') +
      '" data-when="' + esc(when) + '" data-shuttle="' + esc(shuttleCodes(t).join(',')) +
      '" data-track="' + esc(t.trackUrl || '') + '" />' +
      '<div class="zoom-hint">Ketuk untuk perbesar &amp; scan</div>';
  }
  return '<div class="pax">' +
    '<div class="pax-name">' + esc(p.name) + '</div>' +
    '<div class="muted">Kursi ' + esc(p.seat) + ' · ' + esc((p.route || '').replace(/\s+/g, ' ')) + '</div>' +
    img +
    '</div>';
}

function pricesHtml(t) {
  var rows = (t.priceRows || []).map(function (r) {
    return '<tr><td class="kode">' + esc(r.ticketNo) + '</td><td>' + esc(r.seat) +
      '</td><td>' + esc((r.route || '').replace(/\s+/g, ' ')) + '</td><td class="num">' + esc(r.price) + '</td></tr>';
  }).join('');
  return '<table class="prices"><thead><tr><th>No. Tiket</th><th>Kursi</th><th>Rute</th><th class="num">Harga</th></tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
    '<tfoot>' +
      row2('Total Harga', t.totalHarga) +
      row2('Admin Fee', t.adminFee) +
      '<tr class="total-row">' + cell2('Total Bayar', t.totalBayar) + '</tr>' +
    '</tfoot></table>';
}
function row2(label, val) { return '<tr>' + cell2(label, val) + '</tr>'; }
function cell2(label, val) { return '<td colspan="3">' + esc(label) + '</td><td class="num">' + esc(val) + '</td>'; }

function section(title, inner) {
  return '<div class="detail-section"><h3>' + esc(title) + '</h3>' + inner + '</div>';
}
function kv(pairs) {
  var items = pairs.filter(function (p) { return p[1] && String(p[1]).replace(/<[^>]+>/g, '').trim(); })
    .map(function (p) { return '<dt>' + esc(p[0]) + '</dt><dd>' + p[1] + '</dd>'; }).join('');
  return '<dl class="kv">' + items + '</dl>';
}
function mapLink(url) {
  if (!url) return '';
  return '<a href="' + esc(url) + '" target="_blank" rel="noopener">Lihat Maps</a>';
}

/* ===== Util ===== */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtDateTime(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
    }).format(d) + ' WIB';
  } catch (e) { return d.toLocaleString(); }
}
function fmtDateShort(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      day: '2-digit', month: 'short', timeZone: 'Asia/Jakarta'
    }).format(d);
  } catch (e) { return iso; }
}
function fmtClock(ms) {
  var d = new Date(ms);
  try {
    return new Intl.DateTimeFormat('id-ID', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta'
    }).format(d);
  } catch (e) { return d.toLocaleTimeString(); }
}

/* ===== Tema gelap/terang ===== */
function applyTheme(theme) {
  // ikon toggle (matahari/bulan) ditukar via CSS berdasar data-theme
  document.documentElement.setAttribute('data-theme', theme);
}
function initTheme() {
  var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  var saved = localStorage.getItem(THEME_KEY);
  // default ikut OS; nilai tersimpan = override manual dari tombol
  applyTheme(saved || (mq && mq.matches ? 'dark' : 'light'));
  // ikuti perubahan tema OS selama pengguna belum menge-set manual
  if (mq && mq.addEventListener) mq.addEventListener('change', function (e) {
    if (!localStorage.getItem(THEME_KEY)) applyTheme(e.matches ? 'dark' : 'light');
  });
}
if (themeToggle) themeToggle.addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  // kembali ke mode "ikut sistem" bila pilihan manual sama dengan tema OS
  if (next === sys) localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

/* ===== Loncat ke tanggal (datepicker) ===== */
function jumpToDate(val) {
  if (!val) return;

  var anchors = Array.prototype.slice.call(document.querySelectorAll('[data-date]'))
    .filter(function (el) { return el.getAttribute('data-date'); });
  if (!anchors.length) return;

  // Cari kecocokan persis; kalau tak ada, ambil tanggal terdekat yang punya tiket.
  var target = anchors.filter(function (el) { return el.getAttribute('data-date') === val; })[0];
  if (!target) {
    var goal = Date.parse(val + 'T00:00:00+07:00');
    var best = null, bestDiff = Infinity;
    anchors.forEach(function (el) {
      var d = Date.parse(el.getAttribute('data-date') + 'T00:00:00+07:00');
      if (isNaN(d)) return;
      var diff = Math.abs(d - goal);
      if (diff < bestDiff) { bestDiff = diff; best = el; }
    });
    target = best;
    if (target) {
      statusEl.textContent = 'Tak ada tiket ' + val + ', loncat ke ' +
        target.getAttribute('data-date');
    }
  }
  if (!target) return;

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.remove('jump-flash');
  void target.offsetWidth; // restart animasi
  target.classList.add('jump-flash');
}

/* Tanggal ramah, mis. "Selasa, 30 Juni 2026". */
function fmtDateFull(val) {
  var d = new Date(val + 'T00:00:00+07:00');
  if (isNaN(d.getTime())) return val;
  try {
    return new Intl.DateTimeFormat('id-ID', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      timeZone: 'Asia/Jakarta'
    }).format(d);
  } catch (e) { return val; }
}

/* ===== Event lainnya ===== */
var datepickerField = $('datepicker-field');
var datepickerLabel = $('datepicker-label');
datepickerEl.addEventListener('change', function () {
  if (this.value) {
    datepickerLabel.textContent = fmtDateFull(this.value);
    datepickerField.classList.add('has-value');
  } else {
    datepickerLabel.textContent = 'Loncat ke tanggal';
    datepickerField.classList.remove('has-value');
  }
  jumpToDate(this.value);
});

/* Desktop: klik body input type=date tak membuka kalender (hanya ikonnya, yang
   kita sembunyikan via opacity:0). Paksa buka lewat showPicker() saat field diklik. */
datepickerEl.addEventListener('click', function () {
  if (typeof this.showPicker === 'function') {
    try { this.showPicker(); } catch (e) { /* abaikan: butuh user gesture / sudah terbuka */ }
  }
});
$('logout').addEventListener('click', logout);

/* Tombol Segarkan: tarik ulang file (fetch selalu no-store + cache-bust). */
var refreshBtn = $('refresh');
refreshBtn.addEventListener('click', function () {
  if (!password || refreshBtn.disabled) return;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spin');
  var done = function () {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spin');
  };
  loadData(true).then(done, done);
});

/* ===== Init ===== */
(function init() {
  initTheme();
  var saved = localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY);
  if (!saved) { pwInput.focus(); return; }
  password = saved;
  startLoad().catch(function () { password = null; pwInput.focus(); });
})();
