/**
 * Diagnostik sementara — file terpisah supaya gampang ditambah/dihapus dari
 * editor Apps Script tanpa mengutak-atik Code.gs. Hapus file ini kalau sudah
 * tak dipakai.
 *
 * Semua helper yang dipakai (getAoToken_, collectTickets_, keepTodayAndFuture_,
 * trimProp_, _aoMintErr) sudah ada di Code.gs, jadi file ini bisa ditempel
 * apa adanya sebagai file baru.
 */

/**
 * DIAGNOSTIK — jalankan manual dari editor, jangan dipasang ke trigger.
 *
 * Mencetak bentuk respons /reservasi/list untuk SATU akun, buat menjawab satu
 * pertanyaan: apakah API whitelabel sudah mengembalikan kode manifest / link
 * tracking untuk booking kita sendiri, di samping kode_kendaraan?
 *
 * Kalau iya: resolveTrackUrls_ + OUTLET_IDS + trigger refreshTracking semuanya
 * bisa dibuang, dan link lacak tersedia sejak H-1 — bukan cuma beberapa menit
 * sebelum bus tiba di outlet seperti sekarang.
 *
 * Output masuk ke Execution log dan berisi data booking sendiri (nama, telp,
 * kode booking). Jangan ditempel apa adanya ke tempat publik.
 */
function debugReservasiList() {
  var token = getAoToken_();
  if (!token) {
    Logger.log('Token kosong: %s', _aoMintErr || 'cek AOSHUTTLE_CLIENT_ID/SECRET/API_BASE');
    return;
  }

  var acct = null, tickets = keepTodayAndFuture_(collectTickets_());
  for (var i = 0; i < tickets.length && !acct; i++) {
    if (tickets[i].phone && tickets[i].email) acct = tickets[i];
  }
  if (!acct) { Logger.log('Tak ada tiket dengan telp+email.'); return; }

  var url = trimProp_(PropertiesService.getScriptProperties().getProperty('AOSHUTTLE_API_BASE'))
    .replace(/\/+$/, '') + '/api-whitelabel/reservasi/list';
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    payload: { telp: acct.phone, email: acct.email },
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  Logger.log('reservasi/list HTTP %s', res.getResponseCode());
  if (res.getResponseCode() !== 200) { Logger.log('%s', res.getContentText().slice(0, 500)); return; }

  var arr = ((JSON.parse(res.getContentText()) || {}).tiketux || {}).result || [];
  Logger.log('%s reservasi.', arr.length);
  if (!arr.length) return;

  // Gabungan semua nama field — ini inti jawabannya.
  var keys = {};
  arr.forEach(function (r) { for (var k in r) { if (r.hasOwnProperty(k)) keys[k] = true; } });
  Logger.log('FIELD: %s', Object.keys(keys).sort().join(', '));

  var kandidat = Object.keys(keys).filter(function (k) {
    return /manifest|track|map|link|url|hash|armada|kendaraan/i.test(k);
  }).sort();
  Logger.log('KANDIDAT TRACKING: %s', kandidat.join(', ') || '(tak ada)');

  // Inti pertanyaannya: url_tracking terisi untuk booking yang SUDAH dapat
  // kendaraan? Kalau ya, resolveTrackUrls_ + OUTLET_IDS + trigger refreshTracking
  // bisa dibuang dan link tersedia sejak kendaraan di-assign (H-1), bukan cuma
  // beberapa menit sebelum bus tiba di outlet.
  var berkode = arr.filter(function (r) { return String(r.kode_kendaraan || '').trim(); });
  var berlink = berkode.filter(function (r) { return String(r.url_tracking || '').trim(); });
  Logger.log('PUNYA kode_kendaraan: %s dari %s reservasi; di antaranya url_tracking terisi: %s',
    berkode.length, arr.length, berlink.length);

  berkode.slice(0, 10).forEach(function (r) {
    Logger.log('  %s  %s %s  kode=%s  url_tracking=%s',
      r.kode_booking, r.tgl_berangkat, r.jam_berangkat,
      r.kode_kendaraan, String(r.url_tracking || '') || '(kosong)');
  });
}
