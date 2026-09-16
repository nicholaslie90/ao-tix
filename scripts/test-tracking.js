/**
 * Cek logika pencocokan link tracking di apps-script/Code.gs.
 *
 * Yang diuji cuma bagian murni (tanpa UrlFetch/Gmail): normOutlet_,
 * matchArmada_, nextDepartMs_ — plus konsistensi OUTLET_IDS. Fixture di bawah
 * adalah respons asli getTracking/13 (Blok M).
 *
 *   node scripts/test-tracking.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

// Muat Code.gs apa adanya; stub global Apps Script yang disentuh saat load.
var src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
var sandbox = { Logger: { log: function () {} } };
new Function('Logger', 'globalThis', src + '\nglobalThis.__x = { normOutlet_, matchArmada_, nextDepartMs_, OUTLET_IDS, TRACK_AHEAD_MS };')
  (sandbox.Logger, sandbox);
var x = sandbox.__x;

// Fixture: respons asli GET web.aotransportbus.com/getTracking/13
var ARMADA = [
  { no_plate: 'B7306FAB', kode_armada: 'AOLV011', tujuan_akhir: 'CITYWALK LIPPO CIKARANG', eta: 5.31,
    link_map: 'http://live.tracking.asmat.app/map/AO/be39ce73c04f52a3141c45ecb40f5878' },
  { no_plate: 'AB7449JN', kode_armada: 'AOJS015', tujuan_akhir: 'CITYWALK LIPPO CIKARANG', eta: 0.3,
    link_map: 'http://live.tracking.asmat.app/map/AO/3ceb34ea753bb1b43f17aaf811ff183a' }
];

// matchArmada_: ketemu, case-insensitive, dan http -> https (mixed content!)
assert.strictEqual(x.matchArmada_(ARMADA, 'AOLV011'),
  'https://live.tracking.asmat.app/map/AO/be39ce73c04f52a3141c45ecb40f5878');
assert.strictEqual(x.matchArmada_(ARMADA, ' aolv011 '),
  'https://live.tracking.asmat.app/map/AO/be39ce73c04f52a3141c45ecb40f5878');
assert.strictEqual(x.matchArmada_(ARMADA, 'AOJS015').slice(0, 8), 'https://');

// Tidak ketemu / armada kosong / link_map kosong -> '' (bukan undefined/throw)
assert.strictEqual(x.matchArmada_(ARMADA, 'AOLV021'), '');
assert.strictEqual(x.matchArmada_([], 'AOLV011'), '');
assert.strictEqual(x.matchArmada_([{ kode_armada: 'AOLV011', link_map: '' }], 'AOLV011'), '');

// Kode shuttle tak pernah cocok sebagian (AOLV01 != AOLV011)
assert.strictEqual(x.matchArmada_(ARMADA, 'AOLV01'), '');

// link_map itu data pihak ketiga yang berakhir di href + iframe src:
// apa pun di luar host peta yang diharapkan harus ditolak, bukan diteruskan.
['javascript:alert(1)',
 'data:text/html,<script>alert(1)</script>',
 'https://live.tracking.asmat.app.evil.test/map/AO/x',
 'https://evil.test/map/AO/x',
 '//evil.test/map/AO/x',
 ' javascript:alert(1)'
].forEach(function (bad) {
  assert.strictEqual(x.matchArmada_([{ kode_armada: 'AOLV011', link_map: bad }], 'AOLV011'), '',
    'link_map jahat lolos: ' + bad);
});

// normOutlet_ + OUTLET_IDS: "Point Keberangkatan" di tiket harus ketemu id.
assert.strictEqual(x.OUTLET_IDS[x.normOutlet_('Blok M (Jl. Palatehan II)')], 13);
assert.strictEqual(x.OUTLET_IDS[x.normOutlet_('  CITYWALK   LIPPO  CIKARANG ')], 22);
assert.strictEqual(x.OUTLET_IDS[x.normOutlet_('Outlet Antah Berantah')], undefined);
assert.strictEqual(x.normOutlet_(null), '');
assert.strictEqual(x.normOutlet_(undefined), '');

// Semua id outlet unik & berupa angka positif.
var ids = Object.keys(x.OUTLET_IDS).map(function (k) { return x.OUTLET_IDS[k]; });
ids.forEach(function (id) { assert.ok(Number.isInteger(id) && id > 0, 'id outlet tidak valid: ' + id); });
assert.strictEqual(new Set(ids).size, ids.length, 'ada id outlet duplikat');

// nextDepartMs_: ambil keberangkatan terdekat yang belum basi; abaikan
// tanggal invalid dan tiket yang sudah lewat lebih dari ACTIVE_BEFORE_MS.
var now = Date.now();
var iso = function (ms) { return new Date(ms).toISOString(); };
assert.strictEqual(
  x.nextDepartMs_([
    { departISO: iso(now + 5 * 3600000) },
    { departISO: iso(now + 1 * 3600000) },   // paling dekat
    { departISO: 'bukan-tanggal' },
    { departISO: iso(now - 72 * 3600000) }   // sudah basi
  ]),
  Date.parse(iso(now + 1 * 3600000))
);
assert.strictEqual(x.nextDepartMs_([]), 0);
assert.strictEqual(x.nextDepartMs_([{ departISO: iso(now - 72 * 3600000) }]), 0);

console.log('OK: pencocokan link tracking lolos semua cek.');
