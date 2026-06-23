'use strict';

/* ===== Konfigurasi ===== */
// Ambil data dari raw.githubusercontent (update segera setelah commit; tak perlu
// menunggu build GitHub Pages). Fallback ke file lokal kalau raw gagal.
var DATA_RAW = 'https://raw.githubusercontent.com/nicholaslie90/ao-tix/main/data/tickets.enc.json';
var DATA_LOCAL = 'data/tickets.enc.json';
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
var statusEl = $('status'), statsEl = $('stats');
var datepickerEl = $('datepicker');
var themeToggle = $('theme-toggle');
var upcomingEl = $('upcoming'), archiveEl = $('archive'), archiveWrap = $('archive-wrap');
var returnWarnEl = $('return-warning');
var archiveCountEl = $('archive-count'), emptyEl = $('empty');
var modal = $('modal'), modalBody = $('modal-body');
var lightbox = $('lightbox'), lightboxImg = $('lightbox-img'), lightboxCap = $('lightbox-cap');
var lightboxPrev = $('lightbox-prev'), lightboxNext = $('lightbox-next');

/* ===== Crypto (cocok dengan Apps Script) ===== */
function decryptPayload(blob, pw) {
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
  if (!text) throw new Error('wrong-password');
  try { return JSON.parse(text); }
  catch (e) { throw new Error('wrong-password'); }
}

/* ===== Fetch + load ===== */
function fetchBlob() {
  var bust = '?t=' + Date.now();
  return fetch(DATA_RAW + bust, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('raw'); return r.text(); })
    .catch(function () { // fallback ke file di Pages
      return fetch(DATA_LOCAL + bust, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('fetch-failed-' + r.status);
        return r.text();
      });
    });
}

/* Tarik data, dekripsi, render. force=true selalu render ulang. */
function loadData(force) {
  return fetchBlob().then(function (raw) {
    lastChecked = Date.now(); // selalu catat waktu cek, walau data tak berubah
    if (!force && raw === lastCipherText) { updateStatus(); return false; }
    lastCipherText = raw;
    var blob = JSON.parse(raw);
    if (!blob.ct) throw new Error('not-ready'); // placeholder / belum ada data
    var data = decryptPayload(blob, password); // throw wrong-password
    tickets = (data.tickets || []);
    generatedAt = data.generatedAt || null;
    render();
    updateStatus();
    return true;
  });
}

function updateStatus() {
  var parts = [tickets.length + ' tiket'];
  if (generatedAt) parts.push('data ' + fmtDateTime(generatedAt));
  if (lastChecked) parts.push('dicek ' + fmtClock(lastChecked));
  statusEl.textContent = parts.join(' · ');
}

/* ===== Login ===== */
loginForm.addEventListener('submit', function (e) {
  e.preventDefault();
  loginError.hidden = true;
  var pw = pwInput.value;
  if (!pw) return;
  password = pw;
  loadData(true).then(function () {
    if (rememberInput.checked) localStorage.setItem(STORE_KEY, pw);
    else sessionStorage.setItem(STORE_KEY, pw);
    showApp();
  }).catch(function (err) {
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

function showApp() {
  loginEl.hidden = true;
  appEl.hidden = false;
  startPolling();
  // Begitu berhasil login, langsung buka detail trip berikutnya (yang paling dekat)
  // dan tampilkan QR-nya dalam lightbox, seolah QR-nya sudah diketuk.
  var next = nextUpcomingTicket();
  if (next) {
    openModal(next);
    openLightboxFromModal(0);
  }
}

/* Tiket akan datang paling dekat (belum berangkat). null kalau tak ada. */
function nextUpcomingTicket() {
  var now = Date.now();
  var best = null, bestDep = Infinity;
  tickets.forEach(function (t) {
    var dep = Date.parse(t.departISO);
    if (isNaN(dep) || dep < now) return;
    if (dep < bestDep) { bestDep = dep; best = t; }
  });
  return best;
}

function logout() {
  password = null; tickets = []; lastCipherText = null;
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
    loadData(false).catch(function () { /* abaikan error sementara */ });
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
  // Tanggal hari ini di zona WIB (YYYY-MM-DD) — arsip hanya kalau harinya sudah lewat.
  var todayWIB = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
  var upcoming = [], archive = [];

  var missing = annotateMissing(tickets, detectHome(tickets));

  tickets.forEach(function (t) {
    var day = dateKey(t);
    if (day && day < todayWIB) archive.push(t); else upcoming.push(t);
  });

  upcoming.sort(function (a, b) { return Date.parse(a.departISO) - Date.parse(b.departISO); });
  archive.sort(function (a, b) {
    return (Date.parse(b.departISO) || 0) - (Date.parse(a.departISO) || 0);
  });

  upcomingEl.innerHTML = dayGroupsHtml(upcoming);
  archiveEl.innerHTML = dayGroupsHtml(archive);
  archiveWrap.hidden = archive.length === 0;
  archiveCountEl.textContent = archive.length ? '(' + archive.length + ')' : '';
  emptyEl.hidden = tickets.length !== 0;

  renderReturnWarning(missing);
  renderStats();
  bindCards();
}

/* ===== Statistik (dihitung dari SEMUA tiket, bukan hasil filter) ===== */
function parseRupiah(s) {
  var n = String(s == null ? '' : s).replace(/[^\d]/g, '');
  return n ? parseInt(n, 10) : 0;
}
function fmtRupiah(n) { return 'Rp ' + n.toLocaleString('id-ID'); }

function renderStats() {
  if (!tickets.length) { statsEl.hidden = true; statsEl.innerHTML = ''; return; }
  statsEl.hidden = false;
  var total = 0, seats = 0;
  tickets.forEach(function (t) {
    total += parseRupiah(t.totalBayar);
    seats += ((t.priceRows && t.priceRows.length) || (t.passengers && t.passengers.length) || 0);
  });
  statsEl.innerHTML =
    statCard(fmtRupiah(total), 'Total pengeluaran', 'money') +
    statCard(tickets.length, 'Perjalanan', '') +
    statCard(seats, 'Total tiket', '');
}
function statCard(value, label, cls) {
  return '<div class="stat"><div class="stat-value ' + cls + '">' + esc(value) +
    '</div><div class="stat-label">' + esc(label) + '</div></div>';
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
function openModal(t) {
  if (!t) return;
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

function renderLightbox() {
  var item = lbItems[lbIndex];
  if (!item) return;
  lightboxImg.src = item.src;
  lightboxCap.textContent = item.cap || '';
  var multi = lbItems.length > 1;
  lightboxPrev.hidden = !multi;
  lightboxNext.hidden = !multi;
}
function openLightbox(index) {
  if (!lbItems.length) return;
  lbIndex = (index + lbItems.length) % lbItems.length;
  renderLightbox();
  lightbox.hidden = false;
}
function lbStep(delta) {
  if (lbItems.length < 2) return;
  lbIndex = (lbIndex + delta + lbItems.length) % lbItems.length;
  renderLightbox();
}
function closeLightbox() { lightbox.hidden = true; lightboxImg.src = ''; lbItems = []; }

/* Kumpulkan semua QR di modal lalu buka lightbox pada index tertentu.
 * Dipakai saat QR diketuk maupun otomatis setelah login. */
function openLightboxFromModal(index) {
  var imgs = Array.prototype.slice.call(modalBody.querySelectorAll('img.pax-qr'));
  if (!imgs.length) return;
  lbItems = imgs.map(function (el) {
    return { src: el.getAttribute('src'), cap: el.getAttribute('data-cap') };
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
  if (e.target.hasAttribute('data-close-lb')) { closeLightbox(); return; }
  if (e.target.hasAttribute('data-lb-prev')) { lbStep(-1); return; }
  if (e.target.hasAttribute('data-lb-next')) { lbStep(1); return; }
});

/* Swipe untuk geser antar QR (sentuh layar) */
var lbTouchX = null, lbTouchY = null;
lightbox.addEventListener('touchstart', function (e) {
  if (e.touches.length !== 1) { lbTouchX = null; return; }
  lbTouchX = e.touches[0].clientX;
  lbTouchY = e.touches[0].clientY;
}, { passive: true });
lightbox.addEventListener('touchend', function (e) {
  if (lbTouchX === null) return;
  var t = e.changedTouches[0];
  var dx = t.clientX - lbTouchX, dy = t.clientY - lbTouchY;
  lbTouchX = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) lbStep(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('keydown', function (e) {
  if (!lightbox.hidden) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
    return;
  }
  if (e.key === 'Escape' && !modal.hidden) closeModal();
});

function detailHtml(t) {
  return '' +
    '<h2 class="detail-route">' + routeCodes(t) + '</h2>' +
    '<p class="detail-when">' + esc(t.departDate || '') + (t.departTime ? ' · ' + esc(t.departTime) : '') + '</p>' +

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
    ])) +

    section('Penumpang', (t.passengers || []).map(paxHtml).join('') || '<p class="muted">—</p>') +

    section('Harga', pricesHtml(t)) +

    section('Pembayaran', kv([
      ['Metode', esc(t.paymentMethod)],
      ['Waktu', esc(t.paymentTime)]
    ]));
}

function paxHtml(p) {
  var img = '';
  if (p.barcodeUrl) {
    img = '<img class="pax-qr" src="' + esc(p.barcodeUrl) + '" alt="Boarding ' + esc(p.name) +
      '" loading="lazy" data-cap="' + esc((p.name || '') + ' · Kursi ' + (p.seat || '')) + '" />' +
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
  document.documentElement.setAttribute('data-theme', theme);
  // tampilkan ikon aksi: di gelap tawarkan terang (matahari), sebaliknya bulan
  if (themeToggle) themeToggle.textContent = theme === 'light' ? '🌙' : '☀️';
}
function initTheme() {
  var saved = localStorage.getItem(THEME_KEY);
  if (!saved) {
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    saved = prefersLight ? 'light' : 'dark';
  }
  applyTheme(saved);
}
if (themeToggle) themeToggle.addEventListener('click', function () {
  var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, next);
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

  // Buka panel arsip kalau target ada di dalamnya, lalu scroll + sorot.
  if (archiveWrap.contains(target)) archiveWrap.open = true;
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
$('logout').addEventListener('click', logout);

/* ===== Init ===== */
(function init() {
  initTheme();
  var saved = localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY);
  if (!saved) { pwInput.focus(); return; }
  password = saved;
  loadData(true).then(function () { showApp(); })
    .catch(function () { password = null; pwInput.focus(); });
})();
