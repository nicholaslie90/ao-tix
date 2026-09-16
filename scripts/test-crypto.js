/**
 * Cek bahwa dekripsi WebCrypto di assets/app.js benar-benar membaca blob yang
 * dienkripsi Apps Script (encryptPayload_ di apps-script/Code.gs).
 *
 * Ini cek yang paling penting di repo: kalau formatnya meleset sedikit saja,
 * web tak bisa membuka data sama sekali. Yang diuji adalah SUMBER app.js yang
 * sebenarnya — blok cryptonya diambil apa adanya, bukan disalin ulang di sini.
 *
 *   node scripts/test-crypto.js
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var path = require('path');
var { webcrypto } = require('crypto');

var ROOT = path.join(__dirname, '..');

/* --- CryptoJS, dipakai untuk MENGENKRIPSI persis seperti Apps Script --- */
global.window = global;
// crypto-js.min.js itu UMD: di CommonJS ia mengisi module.exports, di browser
// ia mengisi window.CryptoJS. Terima keduanya.
var CryptoJS = require(path.join(ROOT, 'assets', 'crypto-js.min.js')) || global.CryptoJS;
assert.ok(CryptoJS && CryptoJS.PBKDF2, 'CryptoJS gagal dimuat');
global.CryptoJS = CryptoJS;

function randomWordArray(bytes) { return CryptoJS.lib.WordArray.random(bytes); }

/** Salinan setia encryptPayload_ dari apps-script/Code.gs. */
function encryptLikeAppsScript(plaintext, password, iterations) {
  var salt = randomWordArray(16);
  var iv = randomWordArray(16);
  var key = CryptoJS.PBKDF2(password, salt, {
    keySize: 256 / 32, iterations: iterations, hasher: CryptoJS.algo.SHA256
  });
  var encrypted = CryptoJS.AES.encrypt(plaintext, key, {
    iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
  });
  return {
    v: 1,
    iter: iterations,
    salt: salt.toString(CryptoJS.enc.Hex),
    iv: iv.toString(CryptoJS.enc.Hex),
    ct: encrypted.ciphertext.toString(CryptoJS.enc.Base64)
  };
}

/* --- Ambil blok crypto dari app.js apa adanya, jalankan di sandbox --- */
var appSrc = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');
var from = appSrc.indexOf('/* ===== Crypto');
var to = appSrc.indexOf('/* ===== Fetch + load');
assert.ok(from > 0 && to > from, 'blok crypto tak ketemu di app.js — penanda berubah?');
var cryptoSrc = appSrc.slice(from, to);

// Stub browser seadanya. crypto.subtle diisi WebCrypto node (implementasi sama).
var sandbox = {
  window: { crypto: webcrypto, CryptoJS: CryptoJS },
  atob: function (b) { return Buffer.from(b, 'base64').toString('binary'); },
  TextEncoder: TextEncoder,
  TextDecoder: TextDecoder,
  document: { createElement: function () { return {}; }, head: { appendChild: function () {} } }
};
var api = new Function('window', 'atob', 'TextEncoder', 'TextDecoder', 'document',
  cryptoSrc + '\nreturn { decryptPayload: decryptPayload, hexBytes: hexBytes, b64Bytes: b64Bytes };')
  (sandbox.window, sandbox.atob, sandbox.TextEncoder, sandbox.TextDecoder, sandbox.document);

/* --- Helper byte --- */
assert.deepStrictEqual(Array.from(api.hexBytes('00ff10')), [0, 255, 16]);
assert.deepStrictEqual(Array.from(api.b64Bytes('AAEC')), [0, 1, 2]);
assert.strictEqual(api.hexBytes('').length, 0);

/* --- Uji utama: enkripsi ala Apps Script -> dekripsi ala web --- */
var PW = 'rahasia-uji-123';
var payload = {
  generatedAt: new Date().toISOString(),
  tickets: [
    { bookingCode: 'BAOS260810TEST', name: 'CINDY WIJAYA', departISO: '2026-09-16T17:00:00+07:00',
      shuttleCodePergi: 'AOLV021', driverName: 'DIMAS DWI FEBRYANTO',
      // non-ASCII + string panjang: bukti UTF-8 dan padding PKCS#7 tertangani
      address: 'Jl. Kabupaten No. 7 — Sleman, Yogyakarta • ürüñ 日本語',
      note: 'x'.repeat(5000) }
  ]
};

// Iterasi rendah supaya tes cepat; parameter lain identik dengan produksi.
var blob = encryptLikeAppsScript(JSON.stringify(payload), PW, 1000);
assert.strictEqual(blob.salt.length, 32, 'salt harus 16 byte hex');
assert.strictEqual(blob.iv.length, 32, 'iv harus 16 byte hex');

api.decryptPayload(blob, PW).then(function (got) {
  assert.deepStrictEqual(got, payload, 'hasil dekripsi tak sama dengan aslinya');

  // Password salah harus jadi Error('wrong-password'), bukan crash lain —
  // loginForm mengandalkan pesan itu untuk menampilkan "Password salah."
  return api.decryptPayload(blob, PW + 'salah').then(
    function () { throw new Error('password salah malah lolos'); },
    function (e) { assert.strictEqual(e.message, 'wrong-password'); }
  );
}).then(function () {
  // Blob rusak juga harus jatuh ke wrong-password, bukan exception mentah.
  var rusak = Object.assign({}, blob, { ct: blob.ct.slice(0, 40) });
  return api.decryptPayload(rusak, PW).then(
    function () { throw new Error('blob rusak malah lolos'); },
    function (e) { assert.strictEqual(e.message, 'wrong-password'); }
  );
}).then(function () {
  // Jalur cadangan: browser tanpa crypto.subtle harus tetap bisa membuka data
  // lewat CryptoJS. Ini satu-satunya pengaman untuk browser lama, jadi diuji.
  var tanpaSubtle = new Function('window', 'atob', 'TextEncoder', 'TextDecoder', 'document',
    cryptoSrc + '\nreturn { decryptPayload: decryptPayload };')
    ({ crypto: undefined, CryptoJS: CryptoJS },   // subtle tak ada
     sandbox.atob, sandbox.TextEncoder, sandbox.TextDecoder, sandbox.document);
  return tanpaSubtle.decryptPayload(blob, PW).then(function (got) {
    assert.deepStrictEqual(got, payload, 'jalur CryptoJS memberi hasil berbeda');
    return tanpaSubtle.decryptPayload(blob, PW + 'salah').then(
      function () { throw new Error('fallback: password salah malah lolos'); },
      function (e) { assert.strictEqual(e.message, 'wrong-password'); }
    );
  });
}).then(function () {
  // Blob asli di repo: pastikan bentuk fieldnya masih seperti yang diharapkan.
  var real = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tickets.enc.json'), 'utf8'));
  assert.ok(/^[0-9a-f]{32}$/.test(real.salt), 'salt blob nyata tak sesuai bentuk');
  assert.ok(/^[0-9a-f]{32}$/.test(real.iv), 'iv blob nyata tak sesuai bentuk');
  assert.strictEqual(real.iter, 100000, 'iterasi produksi berubah?');
  assert.ok(real.ct.length > 1000, 'ciphertext nyata kok kecil sekali');

  console.log('OK: WebCrypto + jalur cadangan CryptoJS sama-sama membaca blob Apps Script.');
}).catch(function (e) {
  console.error('GAGAL:', e && e.message);
  process.exit(1);
});
