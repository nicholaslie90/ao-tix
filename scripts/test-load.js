/**
 * Cek pemuatan dua fase di assets/app.js.
 *
 * Dua hal yang benar-benar berisiko di sini, keduanya gagal tanpa suara:
 *   1. Balapan: kalau data PENUH tiba duluan, hasil fase cepat (1 tiket) tak
 *      boleh menimpanya — kalau tertimpa, daftar tiket mendadak tinggal satu.
 *   2. Index basi: fase cepat memakai array 1 tiket, lalu `tickets` diganti
 *      array penuh. openTicketIdx/autoIdx harus diselaraskan lewat kode
 *      booking, kalau tidak modal/lightbox menunjuk tiket yang salah.
 *
 * Blok sumbernya diambil apa adanya dari app.js, bukan disalin ulang.
 *
 *   node scripts/test-load.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

var appSrc = fs.readFileSync(path.join(__dirname, '..', 'assets', 'app.js'), 'utf8');
var from = appSrc.indexOf('var fullLoaded = false;');
var to = appSrc.indexOf('function updateStatus()');
assert.ok(from > 0 && to > from, 'blok pemuatan tak ketemu di app.js — penanda berubah?');
var src = appSrc.slice(from, to);

/** Bangun sandbox baru tiap kasus uji supaya state tak bocor antar tes. */
function harness(opts) {
  var calls = { render: 0, showApp: 0, advance: 0 };
  var state = { tickets: [], openTicketIdx: -1, autoIdx: -1, appShown: false };

  var api = new Function(
    'fetchBlob', 'decryptPayload', 'render', 'showApp', 'maybeAdvanceAuto',
    'loadData', 'JSONparseGuard', 'state', 'calls',
    // `tickets` dan kawan-kawan hidup di scope ini, seperti di app.js.
    'var tickets = state.tickets, openTicketIdx = state.openTicketIdx,' +
    '    autoIdx = state.autoIdx, appShown = state.appShown;' +
    // konstanta URL dideklarasikan di bagian lain app.js
    'var NEXT_RAW = "next-raw", NEXT_LOCAL = "next-local",' +
    '    DATA_RAW = "data-raw", DATA_LOCAL = "data-local", password = "pw";' +
    src +
    'return {' +
    '  loadNextOnly: loadNextOnly, realignOpen: realignOpen, startLoad: startLoad,' +
    '  get tickets() { return tickets; }, set tickets(v) { tickets = v; },' +
    '  get openTicketIdx() { return openTicketIdx; }, set openTicketIdx(v) { openTicketIdx = v; },' +
    '  get autoIdx() { return autoIdx; }, set autoIdx(v) { autoIdx = v; },' +
    '  get fullLoaded() { return fullLoaded; }, set fullLoaded(v) { fullLoaded = v; },' +
    '  set appShown(v) { appShown = v; }' +
    '};'
  )(
    opts.fetchBlob,
    opts.decryptPayload,
    function () { calls.render++; },
    function () { calls.showApp++; },
    function () { calls.advance++; },
    opts.loadData,
    null, state, calls
  );
  api.calls = calls;
  return api;
}

var NEXT = { tickets: [{ bookingCode: 'B2' }] };
var FULL = [{ bookingCode: 'B1' }, { bookingCode: 'B2' }, { bookingCode: 'B3' }];
var blob = JSON.stringify({ ct: 'x', salt: '00', iv: '00', iter: 1000 });

/* --- 1. Jalur normal: fase cepat menang, QR tampil duluan --- */
(function () {
  var h = harness({
    fetchBlob: function () { return Promise.resolve(blob); },
    decryptPayload: function () { return Promise.resolve(NEXT); },
    loadData: function () { return new Promise(function () {}); }   // penuh tak kunjung selesai
  });
  return h.loadNextOnly().then(function (ok) {
    assert.strictEqual(ok, true, 'fase cepat harusnya dipakai');
    assert.deepStrictEqual(h.tickets, NEXT.tickets);
    assert.strictEqual(h.calls.render, 1, 'fase cepat harus render sekali');
  });
})()

/* --- 2. Balapan: data penuh menang, fase cepat TIDAK boleh menimpa --- */
  .then(function () {
    var h = harness({
      fetchBlob: function () { return Promise.resolve(blob); },
      decryptPayload: function () { return Promise.resolve(NEXT); },
      loadData: function () { return Promise.resolve(true); }
    });
    h.tickets = FULL;
    h.fullLoaded = true;              // seolah loadData sudah selesai duluan
    return h.loadNextOnly().then(function (ok) {
      assert.strictEqual(ok, false, 'fase cepat harus mengalah saat data penuh sudah masuk');
      assert.deepStrictEqual(h.tickets, FULL, 'daftar tiket penuh tertimpa satu tiket!');
      assert.strictEqual(h.calls.render, 0, 'tak boleh render ulang saat mengalah');
    });
  })

/* --- 3. File kecil kosong (belum ada tiket mendatang) --- */
  .then(function () {
    var h = harness({
      fetchBlob: function () { return Promise.resolve(blob); },
      decryptPayload: function () { return Promise.resolve({ tickets: [] }); },
      loadData: function () { return new Promise(function () {}); }
    });
    return h.loadNextOnly().then(function (ok) {
      assert.strictEqual(ok, false, 'daftar kosong tak boleh dianggap berhasil');
      assert.strictEqual(h.calls.render, 0);
    });
  })

/* --- 4. File kecil belum ada / rusak: harus ditolak, bukan melempar liar --- */
  .then(function () {
    var h = harness({
      fetchBlob: function () { return Promise.reject(new Error('fetch-failed-404')); },
      decryptPayload: function () { return Promise.resolve(NEXT); },
      loadData: function () { return new Promise(function () {}); }
    });
    return h.loadNextOnly().then(
      function () { throw new Error('seharusnya gagal'); },
      function (e) { assert.ok(/fetch-failed/.test(e.message)); }
    );
  })

/* --- 5. Penyelarasan index sesudah array tiket berganti --- */
  .then(function () {
    var h = harness({
      fetchBlob: function () { return Promise.resolve(blob); },
      decryptPayload: function () { return Promise.resolve(NEXT); },
      loadData: function () { return Promise.resolve(true); }
    });
    // Fase cepat: satu tiket, index 0.
    h.tickets = NEXT.tickets;
    h.openTicketIdx = 0;
    h.autoIdx = 0;
    // Data penuh tiba: B2 sekarang ada di index 1.
    h.tickets = FULL;
    h.realignOpen('B2');
    assert.strictEqual(h.openTicketIdx, 1, 'openTicketIdx tak diselaraskan');
    assert.strictEqual(h.autoIdx, 1, 'autoIdx tak diselaraskan');
    assert.strictEqual(h.tickets[h.openTicketIdx].bookingCode, 'B2');

    // Tiket yang terbuka hilang dari data penuh -> index dibiarkan, jangan ngawur.
    h.openTicketIdx = 1; h.autoIdx = 1;
    h.realignOpen('SUDAH-TIDAK-ADA');
    assert.strictEqual(h.openTicketIdx, 1, 'index tak boleh diubah kalau tiket tak ketemu');

    // Tak ada yang terbuka -> no-op.
    h.openTicketIdx = -1; h.autoIdx = -1;
    h.realignOpen('B3');
    assert.strictEqual(h.openTicketIdx, -1, 'tak ada modal terbuka, index harus tetap -1');
    assert.strictEqual(h.autoIdx, -1);
  })

  .then(function () {
    console.log('OK: pemuatan dua fase lolos semua cek (balapan + penyelarasan index).');
  })
  .catch(function (e) {
    console.error('GAGAL:', e && e.message);
    process.exit(1);
  });
