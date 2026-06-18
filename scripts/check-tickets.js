#!/usr/bin/env node
/**
 * Diagnostik lokal: dekripsi data/tickets.enc.json dan laporkan, per tanggal,
 * apakah tiket PERGI (dari rumah) & PULANG (ke rumah) sudah ada.
 *
 * Pakai (password tidak dikirim ke mana pun, hanya dipakai lokal):
 *   node scripts/check-tickets.js 'PASSWORD_ANDA'
 *   # atau:  TICKET_PASSWORD='...' node scripts/check-tickets.js
 */
'use strict';
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var pw = process.argv[2] || process.env.TICKET_PASSWORD;
if (!pw) { console.error('Beri password: node scripts/check-tickets.js \'PASSWORD\''); process.exit(1); }

var file = path.join(__dirname, '..', 'data', 'tickets.enc.json');
var blob = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!blob.ct) { console.error('File belum berisi data terenkripsi.'); process.exit(1); }

var key = crypto.pbkdf2Sync(pw, Buffer.from(blob.salt, 'hex'), blob.iter || 100000, 32, 'sha256');
var d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(blob.iv, 'hex'));
var plain;
try {
  plain = Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
} catch (e) { console.error('Gagal dekripsi — password salah?'); process.exit(1); }

var data = JSON.parse(plain);
var tickets = data.tickets || [];
var genMs = data.generatedAt ? Date.parse(data.generatedAt) : NaN;
console.log('generatedAt:', data.generatedAt, '| total tiket:', tickets.length, '\n');

// Jeda email->push: selisih waktu email masuk (messageDate) vs data dibuat (generatedAt).
function lagText(t) {
  if (!t.messageDate || isNaN(genMs)) return '';
  var ms = genMs - Date.parse(t.messageDate);
  if (isNaN(ms)) return '';
  var mnt = Math.round(ms / 60000);
  return ' | email ' + t.messageDate.slice(0, 16).replace('T', ' ') +
    ' (jeda ke data ' + (mnt >= 0 ? mnt + ' mnt' : 'data lebih lama?') + ')';
}

function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
function dkey(t) { return t.departISO ? t.departISO.slice(0, 10) : '(tanpa tanggal)'; }

// Deteksi rumah = titik asal keberangkatan paling pagi terbanyak.
var earliest = {};
tickets.forEach(function (t) {
  var k = dkey(t); if (k === '(tanpa tanggal)') return;
  if (!earliest[k] || t.departISO < earliest[k].departISO) earliest[k] = t;
});
var votes = {}, home = null, bn = 0;
Object.keys(earliest).forEach(function (k) {
  var p = norm(earliest[k].departurePoint); if (!p) return;
  votes[p] = (votes[p] || 0) + 1;
  if (votes[p] > bn) { bn = votes[p]; home = p; }
});
console.log('Rumah terdeteksi:', home, '\n');

var groups = {};
tickets.forEach(function (t) { (groups[dkey(t)] = groups[dkey(t)] || []).push(t); });

var now = Date.now();
Object.keys(groups).sort().forEach(function (k) {
  var arr = groups[k];
  var pergi = arr.some(function (t) { return norm(t.departurePoint) === home; });
  var pulang = arr.some(function (t) { return norm(t.destinationPoint) === home; });
  var future = arr.some(function (t) { return Date.parse(t.departISO) >= now; });
  var mark = (pergi && pulang) ? 'OK   ' : (pergi ? 'PULANG?' : (pulang ? 'PERGI? ' : '???   '));
  console.log(
    mark, k,
    '| pergi:', pergi ? 'ya' : '-', 'pulang:', pulang ? 'ya' : '-',
    '|', arr.length, 'tiket', future ? '(akan datang)' : '',
    '\n        ', arr.map(function (t) {
      return (t.departurePoint || '?') + '→' + (t.destinationPoint || '?') + ' ' + (t.departTime || '') + lagText(t);
    }).join('\n         ')
  );
});
