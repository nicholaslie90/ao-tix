/**
 * Cek logika link tracking berbasis manifest di apps-script/Code.gs.
 *
 * Yang diuji cuma bagian murni (tanpa UrlFetch/Gmail/Properties):
 * manifestKey_, manifestUrl_, pruneManifestCache_.
 *
 *   node scripts/test-tracking.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');

// Muat Code.gs apa adanya; stub global Apps Script yang disentuh saat load.
var src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
var sandbox = {
  Logger: { log: function () {} },
  Utilities: {
    // Cukup untuk pruneManifestCache_: format tanggal WIB.
    formatDate: function (d) {
      return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
    }
  }
};
new Function('Logger', 'Utilities', 'globalThis',
  src + '\nglobalThis.__x = { manifestKey_, manifestUrl_, pruneManifestCache_, MANIFEST_MAP_URL };')
  (sandbox.Logger, sandbox.Utilities, sandbox);
var x = sandbox.__x;

/* --- manifestKey_ : harus sama persis dengan timeOfDeparture di manifest --- */
// Manifest nyata AOLV021 hari itu: timeOfDeparture "2026-09-16 17:00".
assert.strictEqual(
  x.manifestKey_('AOLV021', '2026-09-16T17:00:00+07:00'),
  'AOLV021|2026-09-16 17:00'
);
// departISO selalu +07:00, jadi jamnya dipotong apa adanya — bukan digeser UTC.
assert.strictEqual(
  x.manifestKey_('AOLV025', '2026-09-16T06:00:00+07:00'),
  'AOLV025|2026-09-16 06:00'
);
// Kode dinormalkan, spasi/huruf kecil tak bikin meleset.
assert.strictEqual(
  x.manifestKey_('  aolv021 ', '2026-09-16T17:00:00+07:00'),
  'AOLV021|2026-09-16 17:00'
);
// Input tak lengkap -> '' (bukan kunci setengah jadi yang diam-diam tak cocok).
assert.strictEqual(x.manifestKey_('', '2026-09-16T17:00:00+07:00'), '');
assert.strictEqual(x.manifestKey_('AOLV021', ''), '');
assert.strictEqual(x.manifestKey_('AOLV021', '2026-09-16'), '');
assert.strictEqual(x.manifestKey_(null, null), '');

/* --- manifestUrl_ : batas kepercayaan, nilai ini masuk href + iframe src --- */
var H = '744a3e2c6f2087cb8a80a8828beb9508';   // manifestCode asli AOLV021
assert.strictEqual(x.manifestUrl_(H), x.MANIFEST_MAP_URL + H);
assert.strictEqual(x.manifestUrl_(H.toUpperCase()), x.MANIFEST_MAP_URL + H.toUpperCase());

// Apa pun yang bukan 32 hex ditolak, bukan diteruskan.
[
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'https://evil.test/map/AO/' + H,
  H.slice(0, 31),                 // kependekan
  H + 'a',                        // kepanjangan
  H.slice(0, 31) + 'g',           // bukan hex
  '', null, undefined
].forEach(function (bad) {
  assert.strictEqual(x.manifestUrl_(bad), '', 'manifestCode jahat lolos: ' + bad);
});

/* --- pruneManifestCache_ : cache tak boleh tumbuh tanpa batas (9 KB/properti) --- */
var iso = function (ms) { return new Date(ms).toISOString().slice(0, 10); };
var now = Date.now();
var cache = {};
cache['AOLV021|' + iso(now) + ' 17:00'] = H;                        // hari ini -> simpan
cache['AOLV023|' + iso(now + 86400000) + ' 06:00'] = H;             // besok -> simpan
cache['AOLV025|' + iso(now - 86400000) + ' 06:00'] = H;             // kemarin -> simpan
cache['AOLC018|' + iso(now - 5 * 86400000) + ' 06:00'] = H;         // 5 hari lalu -> buang
cache['rusak'] = H;                                                 // tanpa tanggal -> buang

var pruned = x.pruneManifestCache_(cache);
assert.ok(pruned['AOLV021|' + iso(now) + ' 17:00'], 'entri hari ini terbuang');
assert.ok(pruned['AOLV023|' + iso(now + 86400000) + ' 06:00'], 'entri besok terbuang');
assert.ok(!pruned['AOLC018|' + iso(now - 5 * 86400000) + ' 06:00'], 'entri lama tak terbuang');
assert.ok(!pruned['rusak'], 'kunci rusak tak terbuang');
assert.strictEqual(x.pruneManifestCache_({}) && Object.keys(x.pruneManifestCache_({})).length, 0);

console.log('OK: logika link tracking (manifest) lolos semua cek.');
