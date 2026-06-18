'use strict';

/* ===== Konfigurasi ===== */
var DATA_URL = 'data/tickets.enc.json';
var POLL_MS = 60000;
var STORE_KEY = 'aoshuttle_pw';

/* ===== State ===== */
var password = null;
var tickets = [];
var lastCipherText = null;
var pollTimer = null;

/* ===== Elemen ===== */
var $ = function (id) { return document.getElementById(id); };
var loginEl = $('login'), appEl = $('app'), loginForm = $('login-form');
var pwInput = $('password'), rememberInput = $('remember'), loginError = $('login-error');
var statusEl = $('status'), searchEl = $('search');
var upcomingEl = $('upcoming'), archiveEl = $('archive'), archiveWrap = $('archive-wrap');
var archiveCountEl = $('archive-count'), emptyEl = $('empty');
var modal = $('modal'), modalBody = $('modal-body');

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
  return fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' })
    .then(function (r) {
      if (!r.ok) throw new Error('fetch-failed-' + r.status);
      return r.text();
    });
}

/* Tarik data, dekripsi, render. force=true selalu render ulang. */
function loadData(force) {
  return fetchBlob().then(function (raw) {
    if (!force && raw === lastCipherText) { return false; }
    lastCipherText = raw;
    var blob = JSON.parse(raw);
    if (!blob.ct) throw new Error('not-ready'); // placeholder / belum ada data
    var data = decryptPayload(blob, password); // throw wrong-password
    tickets = (data.tickets || []);
    render();
    setStatus(data.generatedAt);
    return true;
  });
}

function setStatus(generatedAt) {
  var when = generatedAt ? fmtDateTime(generatedAt) : '—';
  statusEl.textContent = tickets.length + ' tiket · diperbarui ' + when;
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

/* ===== Render ===== */
function render() {
  var q = (searchEl.value || '').toLowerCase().trim();
  var now = Date.now();
  var upcoming = [], archive = [];

  tickets.filter(function (t) { return matchQuery(t, q); }).forEach(function (t) {
    var dep = t.departISO ? Date.parse(t.departISO) : NaN;
    if (!isNaN(dep) && dep >= now) upcoming.push(t); else archive.push(t);
  });

  upcoming.sort(function (a, b) { return Date.parse(a.departISO) - Date.parse(b.departISO); });
  archive.sort(function (a, b) {
    return (Date.parse(b.departISO) || 0) - (Date.parse(a.departISO) || 0);
  });

  upcomingEl.innerHTML = upcoming.map(cardHtml).join('');
  archiveEl.innerHTML = archive.map(cardHtml).join('');
  archiveWrap.hidden = archive.length === 0;
  archiveCountEl.textContent = archive.length ? '(' + archive.length + ')' : '';
  emptyEl.hidden = tickets.length !== 0;

  bindCards();
}

function matchQuery(t, q) {
  if (!q) return true;
  var hay = [t.bookingCode, t.departurePoint, t.destinationPoint, t.departDate,
    t.departTime, t.name].concat(
    (t.passengers || []).map(function (p) { return p.name + ' ' + p.route; })
  ).join(' ').toLowerCase();
  return hay.indexOf(q) >= 0;
}

function cardHtml(t) {
  var idx = tickets.indexOf(t);
  var route = esc(t.departurePoint || routeFromPax(t)) + ' → ' + esc(t.destinationPoint || '');
  var when = esc((t.departDate || '').replace(/\s*$/, '')) + (t.departTime ? ' · ' + esc(t.departTime) : '');
  var pax = (t.passengers || []).length;
  return '' +
    '<article class="card" data-idx="' + idx + '">' +
      '<div class="card-head">' +
        '<span class="card-route">' + routeCodes(t) + '</span>' +
        badge(t) +
      '</div>' +
      '<div class="card-when">' + when + '</div>' +
      '<div class="muted">' + route + '</div>' +
      '<div class="card-meta">' +
        '<span class="kode">' + esc(t.bookingCode || '') + '</span>' +
        '<span>' + pax + ' penumpang</span>' +
        '<span>' + esc(t.totalBayar || '') + '</span>' +
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
document.addEventListener('keydown', function (e) {
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
      ['OTP', '<span class="otp">' + esc(t.otp) + '</span>']
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
  return '<div class="pax">' +
    '<div class="pax-name">' + esc(p.name) + '</div>' +
    '<div class="muted">Kursi ' + esc(p.seat) + ' · ' + esc((p.route || '').replace(/\s+/g, ' ')) + '</div>' +
    (p.barcodeUrl ? '<img src="' + esc(p.barcodeUrl) + '" alt="Boarding ' + esc(p.name) + '" loading="lazy" />' : '') +
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

/* ===== Event lainnya ===== */
searchEl.addEventListener('input', render);
$('refresh').addEventListener('click', function () {
  statusEl.textContent = 'menyegarkan…';
  loadData(true).catch(function (e) { setStatus(); });
});
$('logout').addEventListener('click', logout);

/* ===== Auto-unlock kalau password tersimpan ===== */
(function init() {
  var saved = localStorage.getItem(STORE_KEY) || sessionStorage.getItem(STORE_KEY);
  if (!saved) { pwInput.focus(); return; }
  password = saved;
  loadData(true).then(function () { showApp(); })
    .catch(function () { password = null; pwInput.focus(); });
})();
