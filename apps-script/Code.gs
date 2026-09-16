/**
 * AO Shuttle e-ticket ingestion.
 *
 * Berjalan di akun Gmail penerima tiket. Tiap trigger:
 *   1. Cari email tiket AO Shuttle di Gmail.
 *   2. Parse field tiap tiket dari HTML body.
 *   3. Dedupe by booking code, urutkan keberangkatan terdekat dulu.
 *   4. Enkripsi (AES-CBC, kunci PBKDF2 dari password) dengan CryptoJS.
 *   5. Push ke file terenkripsi di repo GitHub (hanya jika data berubah).
 *
 * Setup (Project Settings -> Script Properties):
 *   GITHUB_TOKEN   : fine-grained PAT, izin Contents Read & write ke repo.
 *   GITHUB_OWNER   : username/owner GitHub.
 *   GITHUB_REPO    : nama repo (mis. ao-shuttle-tickets).
 *   GITHUB_PATH    : data/tickets.enc.json
 *   GITHUB_BRANCH  : main   (opsional, default "main")
 *   TICKET_PASSWORD: password rahasia untuk dekripsi di web.
 *
 * Lalu: jalankan `setup()` sekali (authorize), pasang trigger time-driven
 * tiap 30 menit ke fungsi `syncTickets`.
 */

var SEARCH_QUERY =
  'from:no-reply@mg.tiketux.com subject:"Tiket Elektronik AO Shuttle"';
var PBKDF2_ITERATIONS = 100000;

// Jendela "aktif": tiket yang keberangkatannya dekat (baru lewat s/d minggu depan).
// Dipakai untuk membatasi panggilan API kode shuttle & embed QR agar hemat kuota.
var ACTIVE_BEFORE_MS = 24 * 3600 * 1000;        // s/d 1 hari setelah berangkat
var ACTIVE_AHEAD_MS = 7 * 24 * 3600 * 1000;     // s/d 7 hari sebelum berangkat

function isActive_(t) {
  if (!t.departISO) return false;
  var dep = Date.parse(t.departISO);
  if (isNaN(dep)) return false;
  var now = Date.now();
  return dep >= now - ACTIVE_BEFORE_MS && dep <= now + ACTIVE_AHEAD_MS;
}

var BULAN = {
  'januari': 1, 'februari': 2, 'maret': 3, 'april': 4, 'mei': 5, 'juni': 6,
  'juli': 7, 'agustus': 8, 'september': 9, 'oktober': 10, 'november': 11,
  'desember': 12
};

/** Entry point untuk trigger tiap jam. */
function syncTickets() {
  var props = PropertiesService.getScriptProperties();
  var tickets = collectTickets_();
  tickets = keepTodayAndFuture_(tickets);   // buang tiket yang harinya sudah lewat (WIB)
  enrichShuttleCodes_(tickets);   // isi kode shuttle (no-op bila token belum di-set)
  embedBarcodes_(tickets);        // simpan QR sebagai data URI utk tiket aktif (offline)
  resolveTrackUrls_(tickets);     // isi link lacak posisi (kosong bila belum jalan)

  // Duluan, dan di luar cek LAST_HASH di bawah: tiket terdekat bisa berganti
  // karena waktu berjalan walaupun data tiketnya sendiri tidak berubah.
  pushNextTicket_(tickets, props);

  // Hash HANYA atas data tiket (tanpa generatedAt yang selalu berubah),
  // supaya tak ada commit sampah tiap run saat data tiket tidak berubah.
  var hash = sha256Hex_(JSON.stringify(tickets));
  if (props.getProperty('LAST_HASH') === hash) {
    Logger.log('Tidak ada perubahan (%s tiket). Lewati push.', tickets.length);
    return;
  }

  var payload = JSON.stringify({ generatedAt: new Date().toISOString(), tickets: tickets });
  var enc = encryptPayload_(payload, props.getProperty('TICKET_PASSWORD'));
  pushToGitHub_(JSON.stringify(enc));
  props.setProperty('LAST_HASH', hash);
  Logger.log('Push %s tiket ke GitHub.', tickets.length);
}

/* ----------------------- File kecil "tiket terdekat" --------------------- */
/*
 * Web harus mengunduh seluruh data (±180 KB, berisi semua QR) sebelum bisa
 * menampilkan QR tiket terdekat. Jadi kita tulis juga file kedua yang isinya
 * HANYA tiket terdekat — web mengunduh yang kecil ini lebih dulu, menampilkan
 * QR-nya, lalu memuat sisanya di latar belakang.
 *
 * Formatnya sama persis dengan tickets.enc.json (dienkripsi dengan password
 * yang sama), jadi web memakai jalur dekripsi yang sama.
 */
var GITHUB_NEXT_PATH = 'data/next.enc.json';

/** Tiket paling relevan "sekarang": keberangkatan terdekat yang belum lewat
 *  2 jam. Sengaja sama dengan ticketToAutoOpen() di assets/app.js — file ini
 *  memang untuk tiket yang akan dibuka web duluan. */
function nextTicket_(tickets) {
  var cutoff = Date.now() - 2 * 3600000, best = null, bestDep = Infinity;
  tickets.forEach(function (t) {
    var dep = Date.parse(t.departISO || '');
    if (isNaN(dep) || dep <= cutoff) return;
    if (dep < bestDep) { bestDep = dep; best = t; }
  });
  return best;
}

/** Push file kecil bila isinya berubah. Hash sendiri, terpisah dari LAST_HASH:
 *  tiket terdekat bisa berganti karena waktu berjalan walau data tiket sama. */
function pushNextTicket_(tickets, props) {
  var next = nextTicket_(tickets);
  var body = next ? [next] : [];
  var hash = sha256Hex_(JSON.stringify(body));
  if (props.getProperty('LAST_NEXT_HASH') === hash) return;
  try {
    var payload = JSON.stringify({ generatedAt: new Date().toISOString(), tickets: body });
    var enc = encryptPayload_(payload, props.getProperty('TICKET_PASSWORD'));
    pushToGitHub_(JSON.stringify(enc), GITHUB_NEXT_PATH);
    props.setProperty('LAST_NEXT_HASH', hash);
    Logger.log('Push tiket terdekat (%s).', next ? next.bookingCode : '(kosong)');
  } catch (e) {
    // Gagal di sini tak boleh menggagalkan push data utama — web tetap jalan
    // tanpa file kecil, cuma kembali ke pemuatan satu tahap.
    Logger.log('Push tiket terdekat gagal: %s', e);
  }
}

/** Simpan hanya tiket yang tanggal berangkatnya HARI INI atau setelahnya (WIB).
 *  Tiket tanpa tanggal ikut disimpan (tak bisa dinilai). Ini yang menjaga file
 *  tetap kecil: tiket lama tak pernah ikut ditulis. */
function keepTodayAndFuture_(tickets) {
  var today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  return tickets.filter(function (t) {
    if (!t.departISO) return true;
    return t.departISO.slice(0, 10) >= today;   // ISO 'YYYY-MM-DD...' -> banding leksikografis aman
  });
}

/** Jalankan manual sekali untuk authorize + backfill + tes. */
function setup() {
  syncTickets();
  Logger.log('Setup selesai. Pasang trigger 30 menit ke syncTickets.');
}

/* ----------------------------- Gmail -> data ----------------------------- */

function collectTickets_() {
  var threads = GmailApp.search(SEARCH_QUERY, 0, 200);
  var byCode = {};
  for (var i = 0; i < threads.length; i++) {
    var msgs = threads[i].getMessages();
    for (var j = 0; j < msgs.length; j++) {
      var msg = msgs[j];
      try {
        var t = parseTicket_(msg.getBody(), msg.getDate());
        if (t && t.bookingCode) byCode[t.bookingCode] = t; // dedupe
      } catch (e) {
        Logger.log('Gagal parse message: %s', e);
      }
    }
  }
  var list = Object.keys(byCode).map(function (k) { return byCode[k]; });
  // Keberangkatan terdekat dulu; yang tidak ada tanggal taruh paling bawah.
  list.sort(function (a, b) {
    if (!a.departISO) return 1;
    if (!b.departISO) return -1;
    return a.departISO < b.departISO ? -1 : (a.departISO > b.departISO ? 1 : 0);
  });
  return list;
}

function parseTicket_(html, msgDate) {
  var t = {};
  t.bookingCode = matchOne_(html, /class="kode"[^>]*>\s*([^<]+?)\s*</i);

  t.bookingDate = labelValue_(html, 'Tanggal Booking');
  t.name = labelValue_(html, 'Nama');
  t.address = labelValue_(html, 'Alamat');
  t.phone = labelValue_(html, 'No\\. Telp');
  t.email = labelValue_(html, 'Email');
  t.otp = labelValue_(html, 'OTP');

  t.departurePoint = labelValue_(html, 'Point Keberangkatan');
  t.destinationPoint = labelValue_(html, 'Point Tujuan');

  var outlets = labelValuesAll_(html, 'Alamat Outlet');
  t.departureAddress = outlets[0] || '';
  t.destinationAddress = outlets[1] || '';

  var maps = allMatches_(html, /Maps[^<]*<\/strong><\/td>\s*<td[^>]*>:\s*<a href=['"]([^'"]+)['"]/gi);
  t.departureMaps = maps[0] || '';
  t.destinationMaps = maps[1] || '';

  t.departDate = labelValue_(html, 'Tanggal Berangkat');
  t.departTime = labelValue_(html, 'Jam Berangkat');
  t.departISO = toISO_(t.departDate, t.departTime);

  t.passengers = parsePassengers_(html);
  t.priceRows = parsePriceRows_(html);

  t.totalHarga = labelValue_(html, 'Total Harga');
  t.adminFee = labelValue_(html, 'Admin Fee');
  t.totalBayar = labelValue_(html, 'Total Bayar');

  t.paymentMethod = clean_(matchOne_(html, /Metode Pembayaran\s*:\s*<\/strong>\s*([^<]+)/i));
  t.paymentTime = clean_(matchOne_(html, /Waktu Pembayaran\s*:\s*<\/strong>\s*([^<]+)/i));

  t.messageDate = msgDate ? msgDate.toISOString() : '';
  return t;
}

function parsePassengers_(html) {
  var section = sliceBetween_(html, 'Detail Penumpang', 'Detail Harga');
  var rows = [];
  // Tiap penumpang: img barcode -> nama -> kursi -> rute -> keberangkatan.
  var re = /<img\s+src="\s*([^"\s]+)\s*"\s+alt="barcode"[^>]*>[\s\S]*?<td align="left">([\s\S]*?)<\/td>\s*<td align="center">([\s\S]*?)<\/td>[\s\S]*?<td align="center">([\s\S]*?)<\/td>\s*<td align="center">([\s\S]*?)<\/td>/gi;
  var m;
  while ((m = re.exec(section)) !== null) {
    rows.push({
      barcodeUrl: clean_(m[1]),
      name: clean_(m[2]),
      seat: clean_(m[3]),
      route: clean_(m[4]),
      departure: clean_(m[5])
    });
  }
  return rows;
}

function parsePriceRows_(html) {
  var section = sliceBetween_(html, 'Detail Harga', 'Detail Pembayaran');
  var rows = [];
  // Baris harga diawali nomor tiket TAOS...
  var re = /<td[^>]*>(TAOS[A-Z0-9]+)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/gi;
  var m;
  while ((m = re.exec(section)) !== null) {
    rows.push({
      ticketNo: clean_(m[1]),
      seat: clean_(m[2]),
      route: clean_(m[3]),
      departure: clean_(m[4]),
      price: clean_(m[5])
    });
  }
  return rows;
}

/* ----------------------------- HTML helpers ----------------------------- */

function labelValue_(html, label) {
  var re = new RegExp('<strong>\\s*' + label + '\\s*</strong>\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>', 'i');
  var m = re.exec(html);
  return m ? cleanValue_(m[1]) : '';
}

function labelValuesAll_(html, label) {
  var re = new RegExp('<strong>\\s*' + label + '\\s*</strong>\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>', 'gi');
  var out = [], m;
  while ((m = re.exec(html)) !== null) out.push(cleanValue_(m[1]));
  return out;
}

function allMatches_(html, re) {
  var out = [], m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function matchOne_(html, re) {
  var m = re.exec(html);
  return m ? m[1] : '';
}

function sliceBetween_(html, startMarker, endMarker) {
  var s = html.indexOf(startMarker);
  if (s < 0) s = 0;
  var e = html.indexOf(endMarker, s + startMarker.length);
  if (e < 0) e = html.length;
  return html.substring(s, e);
}

/** Strip tag, hapus ": " di depan, rapikan whitespace. */
function cleanValue_(s) {
  return clean_(String(s).replace(/<[^>]+>/g, '')).replace(/^:\s*/, '');
}

function clean_(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}

/** "Rabu, 01 Juli 2026" + "06:00" -> "2026-07-01T06:00:00+07:00" (WIB). */
function toISO_(dateStr, timeStr) {
  if (!dateStr) return '';
  var m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(dateStr);
  if (!m) return '';
  var day = ('0' + m[1]).slice(-2);
  var mon = BULAN[m[2].toLowerCase()];
  if (!mon) return '';
  var monStr = ('0' + mon).slice(-2);
  var time = '00:00';
  var tm = /(\d{1,2}:\d{2})/.exec(timeStr || dateStr);
  if (tm) time = (tm[1].length === 4 ? '0' : '') + tm[1];
  return m[3] + '-' + monStr + '-' + day + 'T' + time + ':00+07:00';
}

/* ------------------------------- Crypto -------------------------------- */

function encryptPayload_(plaintext, password) {
  if (!password) throw new Error('TICKET_PASSWORD belum di-set di Script Properties.');
  var salt = randomWordArray_(16);
  var iv = randomWordArray_(16);
  var key = CryptoJS.PBKDF2(password, salt, {
    keySize: 256 / 32, iterations: PBKDF2_ITERATIONS, hasher: CryptoJS.algo.SHA256
  });
  var encrypted = CryptoJS.AES.encrypt(plaintext, key, {
    iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
  });
  return {
    v: 1,
    iter: PBKDF2_ITERATIONS,
    salt: salt.toString(CryptoJS.enc.Hex),
    iv: iv.toString(CryptoJS.enc.Hex),
    ct: encrypted.ciphertext.toString(CryptoJS.enc.Base64)
  };
}

/** Random bytes dari Utilities.getUuid() (v4, acak). CryptoJS 4.2 .random butuh
 * native crypto yang tak ada di Apps Script, jadi kita suplai sendiri. */
function randomWordArray_(nBytes) {
  var hex = '';
  while (hex.length < nBytes * 2) {
    hex += Utilities.getUuid().replace(/-/g, '');
  }
  return CryptoJS.enc.Hex.parse(hex.substring(0, nBytes * 2));
}

function sha256Hex_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

/* -------------------------- Live tracking (manifest) --------------------- */
/*
 * Sumber: GET tracking.asmat.app/api/v1/manifest — daftar manifest perjalanan.
 * Tiap baris punya hullCode (= kode shuttle), timeOfDeparture, dan manifestCode;
 * manifestCode itulah URL petanya:
 *   https://live.tracking.asmat.app/map/AO/<manifestCode>
 *
 * Kenapa bukan getTracking/<outlet> seperti percobaan sebelumnya: feed outlet
 * dihitung dari GPS (ia mengembalikan eta + radius), sedangkan armada AOLV yang
 * kita naiki tak pernah mengirim GPS — lastGpsPings dan historyLocation selalu
 * 0, bahkan untuk trip yang sudah selesai. Jadi AOLV TAK PERNAH muncul di feed
 * outlet, berapa lama pun ditunggu. Manifest tidak bergantung GPS: sudah ada
 * sejak H-1 dan cocok persis lewat hullCode + timeOfDeparture.
 *
 * Tanpa GPS, peta menampilkan rute, jadwal, sopir, dan plat — bukan posisi bus.
 * Kalau suatu saat AO menyalakan telemetri AOLV, posisi muncul sendiri tanpa
 * ubah kode.
 *
 * Daftar manifest tak bisa difilter (hanya page/limit) dan memuat manifest
 * operator lain, jadi kita menyisirnya sehemat mungkin: SEKALI SEHARI, dari
 * halaman terakhir mundur, dan HANYA baris yang hullCode-nya milik tiket kita
 * yang disimpan.
 */
var MANIFEST_API = 'https://tracking.asmat.app/api/v1/manifest';
var MANIFEST_MAP_URL = 'https://live.tracking.asmat.app/map/AO/';
var MANIFEST_PAGE_SIZE = 500;
var MANIFEST_MAX_PAGES = 5;                    // ~2500 baris ≈ 2 hari terakhir
var MANIFEST_RETRY_MS = 6 * 3600 * 1000;       // sisir ulang paling cepat 6 jam

/** Kunci cache: kode shuttle + jam berangkat WIB, sama persis dengan
 *  timeOfDeparture di manifest ("AOLV021|2026-09-16 17:00").
 *  departISO selalu berakhiran +07:00, jadi potong saja — tak perlu hitung zona. */
function manifestKey_(code, departISO) {
  if (!code || !departISO || departISO.length < 16) return '';
  return String(code).toUpperCase().trim() + '|' +
    departISO.slice(0, 10) + ' ' + departISO.slice(11, 16);
}

/** manifestCode -> URL peta. '' kalau bentuknya tak sesuai.
 *  Nilai ini berakhir di href + iframe src, jadi dibatasi 32 hex — tak ada
 *  celah untuk skema jahat (javascript:, data:) atau host lain. */
function manifestUrl_(code) {
  return /^[0-9a-f]{32}$/i.test(String(code || '')) ? MANIFEST_MAP_URL + code : '';
}

function loadManifestCache_() {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty('MANIFEST_CACHE') || '{}'); } catch (e) { return {}; }
}

/** Sisir ekor daftar manifest, ambil hanya hullCode yang kita pakai.
 *  wanted = { AOLV021: true, ... }. Return { key: manifestCode }. */
function scanManifests_(wanted) {
  var found = {}, pages = 0;
  try {
    // limit=1 cuma untuk tahu lastPage — murah, tak menarik data.
    var head = UrlFetchApp.fetch(MANIFEST_API + '?limit=1&page=1', { muteHttpExceptions: true });
    if (head.getResponseCode() !== 200) { Logger.log('manifest head HTTP %s', head.getResponseCode()); return found; }
    var total = ((JSON.parse(head.getContentText()) || {}).pagination || {}).total || 0;
    var last = Math.ceil(total / MANIFEST_PAGE_SIZE);
    if (!last) return found;

    for (var pg = last; pg > 0 && pages < MANIFEST_MAX_PAGES; pg--, pages++) {
      var res = UrlFetchApp.fetch(
        MANIFEST_API + '?limit=' + MANIFEST_PAGE_SIZE + '&page=' + pg, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) { Logger.log('manifest page %s HTTP %s', pg, res.getResponseCode()); break; }
      var rows = (JSON.parse(res.getContentText()) || {}).manifest || [];
      rows.forEach(function (r) {
        var hull = String(r.hullCode || '').toUpperCase().trim();
        if (!wanted[hull]) return;                       // bukan armada kita -> buang
        var key = manifestKey_(hull, String(r.timeOfDeparture || '').replace(' ', 'T'));
        if (key && r.manifestCode) found[key] = tripFromRow_(r);
      });
    }
  } catch (e) { Logger.log('scanManifests_ error: %s', e); }
  Logger.log('Manifest: %s halaman disisir, %s entri armada kita.', pages, Object.keys(found).length);
  return found;
}

/** Rangkum satu baris manifest jadi detail perjalanan. Nama field sengaja
 *  pendek: cache ini tinggal di Script Properties yang batasnya 9 KB. */
function tripFromRow_(r) {
  return {
    c: String(r.manifestCode || ''),
    d: String(r.driverName || '').trim(),
    p: String(r.numberPlate || '').trim(),
    e: String(r.eta || '').trim(),
    r: String(r.manifestReal || '').trim(),      // kode perjalanan, buat rujukan ke CS AO
    s: (r.outletList || []).map(function (o) { return String(o.nama || '').trim(); })
        .filter(String).slice(0, 12)
  };
  // Sengaja TIDAK disimpan, sudah dicek di data nyata:
  //   total_penumpang  -> 0 di semua 157 pemberhentian AO (operator lain mengisi)
  //   completedOutlets -> kosong di semua 33 manifest AO (butuh GPS)
  //   isBandara        -> selalu false untuk AO
  //   lat/lon tiap outlet -> tiket sudah punya link Maps asal & tujuan
}

/** Entri cache -> objek trip. Toleran pada cache versi lama yang isinya string
 *  manifestCode saja, biar tak perlu sisir ulang sesudah update. */
function tripOf_(v) {
  if (!v) return null;
  return typeof v === 'string' ? { c: v, d: '', p: '', e: '', r: '', s: [] } : v;
}

/** Isi t.trackUrl dari manifest. In-place, fail-safe (gagal = trackUrl kosong). */
function resolveTrackUrls_(tickets) {
  var props = PropertiesService.getScriptProperties();
  var cache = loadManifestCache_(), wanted = {}, keyed = [];

  tickets.forEach(function (t) {
    t.trackUrl = ''; t.driverName = ''; t.vehiclePlate = '';
    t.tripEta = ''; t.tripRef = ''; t.tripStops = [];
    if (!t.shuttleCodePergi || !t.departISO || !isActive_(t)) return;
    var key = manifestKey_(t.shuttleCodePergi, t.departISO);
    if (!key) return;
    wanted[String(t.shuttleCodePergi).toUpperCase().trim()] = true;
    keyed.push({ t: t, key: key });
  });
  if (!keyed.length) { Logger.log('Tracking: tak ada tiket aktif berkode.'); return; }

  // Sisir kalau (a) belum menyisir hari ini, atau (b) masih ada tiket aktif tanpa
  // kode dan sisir terakhir sudah >6 jam (tiket yang dibeli mendadak).
  var today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var lastDay = props.getProperty('MANIFEST_SCAN_DAY') || '';
  var lastAt = Number(props.getProperty('MANIFEST_SCAN_AT') || 0);
  var missing = keyed.filter(function (k) { return !cache[k.key]; }).length;
  var stale = missing && (Date.now() - lastAt > MANIFEST_RETRY_MS);

  if (lastDay !== today || stale) {
    var found = scanManifests_(wanted);
    for (var k in found) { if (found.hasOwnProperty(k)) cache[k] = found[k]; }
    cache = pruneManifestCache_(cache);
    props.setProperty('MANIFEST_CACHE', JSON.stringify(cache));
    props.setProperty('MANIFEST_SCAN_DAY', today);
    props.setProperty('MANIFEST_SCAN_AT', String(Date.now()));
  } else {
    Logger.log('Manifest: pakai cache (sisir terakhir %s).', lastDay);
  }

  var filled = 0;
  keyed.forEach(function (k) {
    var trip = tripOf_(cache[k.key]);
    var url = trip ? manifestUrl_(trip.c) : '';
    if (!url) { Logger.log('Tracking: %s belum ada manifest-nya.', k.key); return; }
    k.t.trackUrl = url;
    // Detail dari manifest: sopir, plat, estimasi tiba, urutan pemberhentian.
    k.t.driverName = trip.d || '';
    k.t.vehiclePlate = trip.p || '';
    k.t.tripEta = trip.e || '';
    k.t.tripRef = trip.r || '';
    k.t.tripStops = trip.s || [];
    filled++;
  });
  Logger.log('Tracking: %s dari %s tiket aktif dapat link.', filled, keyed.length);
}

/** Buang entri cache yang jam berangkatnya sudah lewat >2 hari, biar Script
 *  Properties tak tumbuh tanpa batas (batasnya 9 KB per properti). */
function pruneManifestCache_(cache) {
  var cutoff = Utilities.formatDate(new Date(Date.now() - 2 * 86400000), 'Asia/Jakarta', 'yyyy-MM-dd');
  var out = {};
  for (var k in cache) {
    if (!cache.hasOwnProperty(k)) continue;
    var tgl = k.split('|')[1] || '';
    if (tgl.slice(0, 10) >= cutoff) out[k] = cache[k];
  }
  return out;
}

/* --------------------------- AO Shuttle API ---------------------------- */
/*
 * Enrich tiap tiket dengan kode kendaraan (shuttle, mis. AOLV021) dari endpoint
 * /reservasi/list — satu panggilan per akun (telp+email) mengembalikan
 * kode_kendaraan untuk semua booking sekaligus. Bersifat additive & fail-safe:
 * kalau credential belum di-set atau API gagal, sync email tetap jalan dan kode
 * shuttle hanya kosong.
 *
 * Script Properties:
 *   AOSHUTTLE_API_BASE      : https://apiwl.aoshuttle.asmat.app  (wajib)
 * Token — pilih salah satu:
 *   Auto (disarankan): AOSHUTTLE_CLIENT_ID + AOSHUTTLE_CLIENT_SECRET
 *     -> di-mint tiap run via POST {API_BASE}/api-whitelabel/client_token.php
 *        (grant_type=client_credentials). Tidak pernah kedaluwarsa.
 *   Manual (fallback): AOSHUTTLE_TOKEN (Bearer, kedaluwarsa ~7 hari).
 */

function aoCredsComplete_() {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty('AOSHUTTLE_API_BASE')) return false;
  var canMint = p.getProperty('AOSHUTTLE_CLIENT_ID') && p.getProperty('AOSHUTTLE_CLIENT_SECRET');
  return !!(canMint || p.getProperty('AOSHUTTLE_TOKEN'));
}

/** Access token untuk API AO Shuttle. Auto-mint bila client creds ada, jika tidak
 *  jatuh ke token manual. Return string atau null. */
function trimProp_(v) { return String(v || '').trim(); }

// Detail kegagalan mint terakhir dalam satu run; dipakai enrichWarn_ agar email
// alert menyebut sebab sebenarnya (mis. HTTP 500 upstream) bukan tebakan config.
var _aoMintErr = '';

function getAoToken_() {
  var p = PropertiesService.getScriptProperties();
  _aoMintErr = '';
  // trim: spasi/newline saat paste ke Script Properties = penyebab tersering.
  var id = trimProp_(p.getProperty('AOSHUTTLE_CLIENT_ID'));
  var secret = trimProp_(p.getProperty('AOSHUTTLE_CLIENT_SECRET'));
  var base = trimProp_(p.getProperty('AOSHUTTLE_API_BASE')).replace(/\/+$/, '');  // buang trailing slash
  if (id && secret && base) {
    try {
      var res = UrlFetchApp.fetch(base + '/api-whitelabel/client_token.php', {
        method: 'post',
        payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
        muteHttpExceptions: true
      });
      var code = res.getResponseCode();
      var text = res.getContentText();
      if (code === 200) {
        var j = JSON.parse(text);
        var tok = (j.tiketux && j.tiketux.result && j.tiketux.result.access_token) || j.access_token;
        if (tok) return String(tok);
      }
      _aoMintErr = 'client_token.php HTTP ' + code + ': ' + text.slice(0, 200);
      Logger.log(_aoMintErr);
    } catch (e) {
      _aoMintErr = 'mint token error: ' + e;
      Logger.log(_aoMintErr);
    }
  }
  return trimProp_(p.getProperty('AOSHUTTLE_TOKEN')) || null;  // fallback manual
}

/** Satu panggilan /reservasi/list -> map { kode_booking: kode_kendaraan }. */
function fetchShuttleMap_(telp, email, token) {
  var p = PropertiesService.getScriptProperties();
  var url = trimProp_(p.getProperty('AOSHUTTLE_API_BASE')).replace(/\/+$/, '') + '/api-whitelabel/reservasi/list';
  var map = {};
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: { telp: telp, email: email },
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('reservasi/list HTTP %s', res.getResponseCode());
      return map;
    }
    var arr = (JSON.parse(res.getContentText()).tiketux || {}).result || [];
    arr.forEach(function (r) {
      var code = String(r.kode_kendaraan || '').trim();
      if (r.kode_booking && code) map[r.kode_booking] = code;
    });
  } catch (e) {
    Logger.log('reservasi/list error: %s', e);
  }
  return map;
}

/** Isi shuttleCodePergi untuk tiket yang belum punya kode. In-place.
 *  Satu tiket = satu leg = satu kode_kendaraan (disimpan di shuttleCodePergi). */
function enrichShuttleCodes_(tickets) {
  // Berapa tiket aktif yang MASIH butuh kode -> penentu apakah API perlu dipanggil.
  var needCount = tickets.filter(function (t) { return !t.shuttleCodePergi && isActive_(t); }).length;

  if (!aoCredsComplete_()) {
    enrichWarn_('credential AO Shuttle belum lengkap (AOSHUTTLE_API_BASE + CLIENT_ID/SECRET)', urgentNoCode_(tickets));
    return;
  }
  // Hemat kuota: hanya panggil API bila ada tiket aktif yang belum punya kode.
  if (!needCount) { Logger.log('Enrich dilewati: tak ada tiket aktif tanpa kode.'); clearEnrichWarn_(); return; }
  var token = getAoToken_();
  if (!token) { enrichWarn_(_aoMintErr || 'token kosong (cek AOSHUTTLE_CLIENT_ID/SECRET/API_BASE — spasi/newline?)', urgentNoCode_(tickets)); return; }

  // Kumpulkan pasangan (telp,email) unik dari tiket -> 1 panggilan list per akun.
  var seen = {}, accounts = [];
  tickets.forEach(function (t) {
    if (!t.phone || !t.email) return;
    var k = t.phone + '|' + t.email;
    if (!seen[k]) { seen[k] = true; accounts.push({ telp: t.phone, email: t.email }); }
  });

  var map = {};
  accounts.forEach(function (a) {
    var m = fetchShuttleMap_(a.telp, a.email, token);
    for (var kb in m) { if (m.hasOwnProperty(kb)) map[kb] = m[kb]; }
  });

  var filled = 0;
  tickets.forEach(function (t) {
    if (t.shuttleCodePergi) return;                 // sudah ada
    var code = map[t.bookingCode];
    if (code) { t.shuttleCodePergi = code; filled++; }
  });
  Logger.log('Enrich(list): %s tiket dapat kode dari %s akun.', filled, accounts.length);
  // Peringatan hanya kalau tiket hari ini / H+1 masih tanpa kode (yang lain bisa nyusul run berikut).
  enrichWarn_('API sukses tapi kode tiket hari ini/H+1 tak terisi (cek kode_kendaraan kosong / kode_booking tak cocok)', urgentNoCode_(tickets));
}

/** Jumlah tiket yang berangkat HARI INI atau H+1 (WIB) yang masih tanpa kode shuttle. */
function urgentNoCode_(tickets) {
  var today = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  var tmrw = Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Jakarta', 'yyyy-MM-dd');
  return tickets.filter(function (t) {
    if (t.shuttleCodePergi || !t.departISO) return false;
    var d = t.departISO.slice(0, 10);
    return d === today || d === tmrw;
  }).length;
}

/** Peringatan enrich kode shuttle: log + email ke pemilik skrip. Deduplikasi via
 *  Script Property supaya tak spam tiap jam — kirim sekali per kondisi, lalu diam
 *  sampai kondisinya berubah. clearEnrichWarn_() dipanggil saat enrich sukses,
 *  sehingga kegagalan berikutnya memberi tahu lagi. */
function enrichWarn_(reason, urgentCount) {
  Logger.log('PERINGATAN enrich: %s (%s tiket hari ini/H+1 tanpa kode)', reason, urgentCount);
  // ponytail: notifikasi email dimatikan — cukup log di Executions. Aktifkan lagi
  // dgn uncomment blok MailApp di bawah kalau butuh alert.
  // if (!urgentCount) { clearEnrichWarn_(); return; }
  // var p = PropertiesService.getScriptProperties();
  // if (p.getProperty('ENRICH_WARN') === reason) return;
  // p.setProperty('ENRICH_WARN', reason);
  // try {
  //   MailApp.sendEmail(
  //     Session.getEffectiveUser().getEmail(),
  //     'AO Shuttle: kode shuttle gagal terisi',
  //     'Kode shuttle tiket hari ini / H+1 gagal terisi.\n\n' +
  //     'Sebab: ' + reason + '\n' +
  //     'Tiket hari ini/H+1 tanpa kode: ' + urgentCount + '\n\n' +
  //     'Detail HTTP ada di Apps Script > Executions > syncTickets.');
  // } catch (e) { Logger.log('Gagal kirim email peringatan: %s', e); }
}
function clearEnrichWarn_() { PropertiesService.getScriptProperties().deleteProperty('ENRICH_WARN'); }

/** Simpan QR boarding sebagai data URI (base64) untuk tiket aktif, supaya QR
 *  tetap tampil tanpa fetch ke host gambar (mis. di halte dengan sinyal buruk).
 *  Tiket di luar jendela aktif tetap pakai barcodeUrl remote (jarang dipindai). */
function embedBarcodes_(tickets) {
  var done = 0;
  tickets.forEach(function (t) {
    if (!isActive_(t)) return;
    (t.passengers || []).forEach(function (p) {
      if (!p.barcodeUrl || p.barcodeData) return;   // tak ada / sudah tertanam
      try {
        var res = UrlFetchApp.fetch(p.barcodeUrl, { muteHttpExceptions: true });
        if (res.getResponseCode() !== 200) { Logger.log('QR HTTP %s: %s', res.getResponseCode(), p.barcodeUrl); return; }
        var blob = res.getBlob();
        p.barcodeData = 'data:' + blob.getContentType() + ';base64,' + Utilities.base64Encode(blob.getBytes());
        done++;
      } catch (e) {
        Logger.log('embedBarcodes_ error %s: %s', p.barcodeUrl, e);
      }
    });
  });
  Logger.log('Embed QR: %s gambar ditanam (tiket aktif).', done);
}

/* ------------------------------- GitHub -------------------------------- */

function pushToGitHub_(content, pathOverride) {
  var props = PropertiesService.getScriptProperties();
  var owner = props.getProperty('GITHUB_OWNER');
  var repo = props.getProperty('GITHUB_REPO');
  var path = pathOverride || props.getProperty('GITHUB_PATH') || 'data/tickets.enc.json';
  var branch = props.getProperty('GITHUB_BRANCH') || 'main';
  var token = props.getProperty('GITHUB_TOKEN');
  if (!owner || !repo || !token) throw new Error('GITHUB_OWNER/REPO/TOKEN belum di-set.');

  var url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
  var headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // Ambil sha file lama (kalau ada) untuk update.
  var sha = null;
  var get = UrlFetchApp.fetch(url + '?ref=' + branch, {
    method: 'get', headers: headers, muteHttpExceptions: true
  });
  if (get.getResponseCode() === 200) sha = JSON.parse(get.getContentText()).sha;

  var body = {
    message: 'Update tiket AO Shuttle (' + new Date().toISOString() + ')',
    content: Utilities.base64Encode(content, Utilities.Charset.UTF_8),
    branch: branch
  };
  if (sha) body.sha = sha;

  var put = UrlFetchApp.fetch(url, {
    method: 'put', headers: headers, contentType: 'application/json',
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = put.getResponseCode();
  if (code !== 200 && code !== 201) {
    throw new Error('GitHub push gagal (' + code + '): ' + put.getContentText());
  }
}
