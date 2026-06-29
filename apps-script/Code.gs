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

// Enrich kode shuttle (kode_kendaraan) hanya untuk booking dalam jendela ini —
// armada baru di-assign menjelang berangkat, jadi tak perlu cek booking jauh.
var ENRICH_BEFORE_MS = 24 * 3600 * 1000;   // sampai 24 jam setelah berangkat
var ENRICH_AHEAD_MS = 48 * 3600 * 1000;    // sampai 48 jam sebelum berangkat

var BULAN = {
  'januari': 1, 'februari': 2, 'maret': 3, 'april': 4, 'mei': 5, 'juni': 6,
  'juli': 7, 'agustus': 8, 'september': 9, 'oktober': 10, 'november': 11,
  'desember': 12
};

/** Entry point untuk trigger tiap 30 menit. */
function syncTickets() {
  var props = PropertiesService.getScriptProperties();
  var tickets = collectTickets_();
  enrichShuttleCodes_(tickets);   // isi kode shuttle (no-op bila token belum di-set)

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

/* --------------------------- AO Shuttle API ---------------------------- */
/*
 * Enrich tiap tiket dengan kode kendaraan (shuttle, mis. AOLV021) dari endpoint
 * /reservasi/detail. Bersifat additive & fail-safe: kalau token/credential belum
 * di-set atau API gagal, sync email tetap jalan dan kode shuttle hanya kosong.
 *
 * Script Properties (Strategy A — token manual, jalan sekarang):
 *   AOSHUTTLE_TOKEN    : Bearer access token dari sesi app (client_credentials).
 *   AOSHUTTLE_API_BASE : https://apiwl.aoshuttle.asmat.app
 *
 * Upgrade ke auto (Strategy B) nanti: cukup ganti isi getAoToken_() untuk
 * mint token via POST {AOSHUTTLE_TOKEN_BASE}/client_token.php
 * (grant_type=client_credentials, client_id, client_secret). Fungsi lain tetap.
 */

function aoCredsComplete_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('AOSHUTTLE_TOKEN') && p.getProperty('AOSHUTTLE_API_BASE'));
}

/** Access token untuk API AO Shuttle. Strategy A: ambil dari Script Property. */
function getAoToken_() {
  return PropertiesService.getScriptProperties().getProperty('AOSHUTTLE_TOKEN') || null;
}

/** Ambil kode kendaraan satu booking. Return {pergi, pulang} (string, '' bila tak ada). */
function fetchShuttleCode_(bookingCode, token) {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('AOSHUTTLE_API_BASE') + '/api-whitelabel/reservasi/detail';
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: { kodebooking: bookingCode },   // NB: tanpa underscore
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('fetchShuttleCode_(%s) HTTP %s', bookingCode, res.getResponseCode());
      return { pergi: '', pulang: '' };
    }
    var json = JSON.parse(res.getContentText());
    var r = (json.tiketux && json.tiketux.result) || null;
    if (!r) return { pergi: '', pulang: '' };
    return {
      pergi: String(r.kode_kendaraan_pergi || '').trim(),
      pulang: String(r.kode_kendaraan_pulang || '').trim()
    };
  } catch (e) {
    Logger.log('fetchShuttleCode_(%s) error: %s', bookingCode, e);
    return { pergi: '', pulang: '' };
  }
}

/** Untuk booking dalam jendela & belum punya kode: isi shuttleCodePergi/Pulang. In-place. */
function enrichShuttleCodes_(tickets) {
  if (!aoCredsComplete_()) { Logger.log('Enrich dilewati: AOSHUTTLE_TOKEN/API_BASE belum di-set.'); return; }
  var now = Date.now();
  var due = tickets.filter(function (t) {
    if (t.shuttleCodePergi) return false;                 // sudah ada
    if (!t.bookingCode || !t.departISO) return false;
    var dep = Date.parse(t.departISO);
    if (isNaN(dep)) return false;
    return dep >= now - ENRICH_BEFORE_MS && dep <= now + ENRICH_AHEAD_MS;
  });
  if (!due.length) return;
  var token = getAoToken_();
  if (!token) { Logger.log('Enrich dilewati: token kosong.'); return; }
  var filled = 0;
  due.forEach(function (t) {
    var c = fetchShuttleCode_(t.bookingCode, token);
    if (c.pergi) { t.shuttleCodePergi = c.pergi; }
    if (c.pulang) { t.shuttleCodePulang = c.pulang; }
    if (c.pergi || c.pulang) { filled++; }
  });
  Logger.log('Enrich: %s booking dicek, %s dapat kode shuttle.', due.length, filled);
}

/* ------------------------------- GitHub -------------------------------- */

function pushToGitHub_(content) {
  var props = PropertiesService.getScriptProperties();
  var owner = props.getProperty('GITHUB_OWNER');
  var repo = props.getProperty('GITHUB_REPO');
  var path = props.getProperty('GITHUB_PATH') || 'data/tickets.enc.json';
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
