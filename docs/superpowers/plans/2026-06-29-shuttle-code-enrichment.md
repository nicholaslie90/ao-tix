# Shuttle Code (AOLV) Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface each booking's shuttle/armada code (`AOLV0xx`) in the `ao-tix` web app by enriching ticket data from the AO Shuttle `/reservasi/detail` API inside the existing hourly Apps Script sync.

**Architecture:** A one-time interactive capture obtains the app's `client_id`/`client_secret`/host config. The Apps Script (`Code.gs`) mints a `client_credentials` token each run, calls `/reservasi/detail` (POST, body `kodebooking=`) for bookings near departure, and writes `shuttleCodePergi`/`shuttleCodePulang` onto each ticket before the existing hash → encrypt → push. The web app (`app.js`) renders the code when present. Enrichment is additive and fail-safe: missing creds or API errors leave the existing email-only sync untouched.

**Tech Stack:** Google Apps Script (V8 runtime, `UrlFetchApp`, `PropertiesService`), Bash + curl + jq (local helper), vanilla ES5 browser JS (`assets/app.js`), plain CSS. Two repos: `ao-tix` (web app + Apps Script) and `ao-shuttle-decompiler` (local diagnostic script + capture artifacts).

> **Testing note:** This repo has no automated test harness (static site + Apps Script). "Tests" in this plan are concrete manual verification commands with expected output. Run each exactly as written and confirm the expected result before moving on.

## Global Constraints

- AO Shuttle detail endpoint: `POST {API_BASE}/api-whitelabel/reservasi/detail`, body form field **`kodebooking`** (NO underscore), header `Authorization: Bearer <token>`. Response shape: `{"tiketux":{"status":"OK","result":{...}}}`.
- Token endpoint: `POST {TOKEN_BASE}/client_token.php`, body `grant_type=client_credentials&client_id=…&client_secret=…`. Access token read at `tiketux.result.access_token` (fall back to top-level `access_token`).
- Ticket fields are camelCase (`bookingCode`, `departISO`, …). New fields: `shuttleCodePergi`, `shuttleCodePulang`. Set only when API returns a non-empty value.
- Apps Script Script Properties used: `AOSHUTTLE_CLIENT_ID`, `AOSHUTTLE_CLIENT_SECRET`, `AOSHUTTLE_TOKEN_BASE`, `AOSHUTTLE_API_BASE`. If ANY is missing, enrichment is skipped entirely.
- Enrich window: ticket `departISO` within `now − 24h` … `now + 48h`. Constant.
- Apps Script runs hourly; mint exactly one token per run and reuse it for all bookings.
- `ao-tix` repo commits/pushes as GitHub user `nicholaslie90`; if `git push` is rejected, `git pull --rebase` then push (an Apps Script bot also pushes `data/tickets.enc.json` to `main`).
- Known constraint: `/reservasi/list` is server-side broken (503/timeout) as of June 2026 — do NOT use it; enrich per booking via `/reservasi/detail`.

## File Structure

- `ao-shuttle-decompiler/get_booking_detail.sh` — **create**. Local diagnostic: given a booking code, mint a token and print shuttle code + plate + driver + status.
- `ao-tix/apps-script/Code.gs` — **modify**. Add config constants + `getAoToken_`, `fetchShuttleCode_`, `enrichShuttleCodes_`; call `enrichShuttleCodes_` in `syncTickets` before hashing.
- `ao-tix/assets/app.js` — **modify**. Add `shuttleText(t)` helper; render in card meta and detail "Keberangkatan" section.
- `ao-tix/assets/style.css` — **modify**. Add `.shuttle` badge style.
- `ao-shuttle-decompiler/.gitignore` (or env file) — ensure captured secrets are NOT committed.

---

### Task 1: Capture AO Shuttle credentials (interactive, one-time)

Produces the four config values every later task depends on. No code ships in this task — it ends when a raw `curl` token mint succeeds and a detail call returns `"BERHASIL!"`.

**Files:** none created (values recorded into a scratch note + later into Apps Script Script Properties).

**Interfaces:**
- Produces: `CLIENT_ID`, `CLIENT_SECRET`, `TOKEN_BASE` (scheme+host serving `/client_token.php`), `API_BASE` (scheme+host serving `/api-whitelabel/...`, known to be `https://apiwl.aoshuttle.asmat.app`). Consumed by Tasks 2–5.

- [ ] **Step 1: Boot the capture emulator and find the app package**

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
emulator -avd ao_capture -no-snapshot-load &   # wait for full boot
adb wait-for-device
adb shell pm list packages | grep -iE 'shuttle|aotrans|asmat'
```
Expected: one package line, e.g. `package:com.asmat.aoshuttle` (record the exact id as `PKG`).

- [ ] **Step 2 (Method A — preferred): root-pull SharedPreferences**

```bash
adb root              # AVD without Google Play is rootable
adb shell "cat /data/data/PKG/shared_prefs/*.xml" | grep -iE 'client_id|client_secret|base_host_api|host_name_api'
```
Expected: XML `<string name="client_id">…</string>`, `client_secret`, and `base_host_api` (and/or `host_name_api`). Record the values.

If `adb root` is denied or the app must be re-logged-in, use Method B.

- [ ] **Step 3 (Method B — fallback): capture `/client_token.php` with mitmproxy**

In Terminal A: `mitmweb --listen-host 0.0.0.0 --listen-port 8083`
Install + open the patched app per `RUNBOOK.md` (Steps 2–4), log in via OTP. In the mitmweb UI find the request to a path ending **`/client_token.php`** and read from its POST body: `client_id`, `client_secret`. The request's scheme+host is `TOKEN_BASE`.

- [ ] **Step 4: Verify a token mint (raw curl)**

```bash
TOKEN_BASE="https://REPLACE_host"      # from capture (base_host_api)
CLIENT_ID="REPLACE"; CLIENT_SECRET="REPLACE"
curl -sS --max-time 20 -X POST "$TOKEN_BASE/client_token.php" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" | jq .
```
Expected: JSON containing an access token. Note its exact path (`.tiketux.result.access_token` or `.access_token`). Record `TOKEN_BASE`.

- [ ] **Step 5: Verify detail works with the minted token**

```bash
TOKEN=$(curl -sS --max-time 20 -X POST "$TOKEN_BASE/client_token.php" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "client_secret=$CLIENT_SECRET" \
  | jq -r '.tiketux.result.access_token // .access_token')
curl -sS --max-time 25 -X POST "https://apiwl.aoshuttle.asmat.app/api-whitelabel/reservasi/detail" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "kodebooking=BAOS2605300P1Z" | jq '.tiketux | {status, pesan}'
```
Expected: `{ "status": "OK", "pesan": "BERHASIL!" }`. Record `API_BASE=https://apiwl.aoshuttle.asmat.app`.

- [ ] **Step 6: Record the four values** into the scratchpad (NOT committed): `CLIENT_ID`, `CLIENT_SECRET`, `TOKEN_BASE`, `API_BASE`, plus the confirmed access-token JSON path.

---

### Task 2: `get_booking_detail.sh` local helper

**Files:**
- Create: `ao-shuttle-decompiler/get_booking_detail.sh`
- Modify: `ao-shuttle-decompiler/.gitignore` (create if absent) — add `.ao_env`

**Interfaces:**
- Consumes: `CLIENT_ID`, `CLIENT_SECRET`, `TOKEN_BASE`, `API_BASE` (from Task 1), read from env or a sourced `.ao_env`.
- Produces: prints shuttle code + plate + driver + status for one booking. No code dependency for later tasks (reference implementation only).

- [ ] **Step 1: Create `.gitignore` entry so secrets never get committed**

Create/append `ao-shuttle-decompiler/.gitignore`:
```
.ao_env
```

- [ ] **Step 2: Write the script**

Create `ao-shuttle-decompiler/get_booking_detail.sh`:
```bash
#!/usr/bin/env bash
# Print shuttle/armada code (AOLV0xx) + plate + driver + status for one booking.
# Mints its own token via client_credentials — no manual token needed.
#
# Config: export these, or put them in ./.ao_env (gitignored):
#   CLIENT_ID, CLIENT_SECRET, TOKEN_BASE, API_BASE
# Usage: ./get_booking_detail.sh BAOS2605300P1Z
set -euo pipefail
[ -f "$(dirname "$0")/.ao_env" ] && . "$(dirname "$0")/.ao_env"
: "${CLIENT_ID:?set CLIENT_ID}"; : "${CLIENT_SECRET:?set CLIENT_SECRET}"
: "${TOKEN_BASE:?set TOKEN_BASE}"; : "${API_BASE:?set API_BASE}"
KODE="${1:?usage: get_booking_detail.sh KODE_BOOKING}"

TOKEN=$(curl -sS --max-time 20 -X POST "$TOKEN_BASE/client_token.php" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  | jq -r '.tiketux.result.access_token // .access_token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
  echo "Gagal mint token — cek CLIENT_ID/SECRET/TOKEN_BASE." >&2; exit 1
fi

curl -sS --max-time 25 -X POST "$API_BASE/api-whitelabel/reservasi/detail" \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "kodebooking=$KODE" \
| jq '.tiketux as $t | {
    status: $t.status, pesan: $t.pesan,
    kode_booking: $t.result.kode_booking,
    shuttle_pergi: $t.result.kode_kendaraan_pergi,
    shuttle_pulang: $t.result.kode_kendaraan_pulang,
    plat_pergi: $t.result.nomor_polisi_pergi,
    sopir_pergi: $t.result.nama_sopir_pergi,
    status_trip: $t.result.status_trip,
    tgl_pergi: $t.result.tgl_berangkat_pergi,
    jam_pergi: $t.result.jam_berangkat_pergi
  }'
```

- [ ] **Step 3: Make executable and create local `.ao_env`**

```bash
chmod +x ao-shuttle-decompiler/get_booking_detail.sh
printf 'CLIENT_ID=%s\nCLIENT_SECRET=%s\nTOKEN_BASE=%s\nAPI_BASE=%s\n' \
  "$CLIENT_ID" "$CLIENT_SECRET" "$TOKEN_BASE" "https://apiwl.aoshuttle.asmat.app" \
  > ao-shuttle-decompiler/.ao_env
```

- [ ] **Step 4: Test against the real booking**

Run: `cd ao-shuttle-decompiler && ./get_booking_detail.sh BAOS2605300P1Z`
Expected: JSON with `"status":"OK"`, `"pesan":"BERHASIL!"`, `"kode_booking":"BAOS2605300P1Z"`. (`shuttle_pergi` may be `null` until the armada is assigned — that is correct.)

- [ ] **Step 5: Confirm `.ao_env` is ignored, then commit only the script + gitignore**

```bash
cd ao-shuttle-decompiler && git status --porcelain   # must NOT list .ao_env
git add get_booking_detail.sh .gitignore
git commit -m "Add get_booking_detail.sh: ambil kode shuttle per booking via client_credentials"
```
Expected: `git status` shows `.ao_env` untracked-and-ignored (absent from the list because ignored).

---

### Task 3: `Code.gs` — config constants + `getAoToken_`

**Files:**
- Modify: `ao-tix/apps-script/Code.gs` (add near the top config block, after `PBKDF2_ITERATIONS`)

**Interfaces:**
- Consumes: Script Properties `AOSHUTTLE_CLIENT_ID`, `AOSHUTTLE_CLIENT_SECRET`, `AOSHUTTLE_TOKEN_BASE`.
- Produces: `getAoToken_()` → returns access-token string, or `null` on any failure. `aoCredsComplete_()` → boolean.

- [ ] **Step 1: Add the enrich-window constant** next to `PBKDF2_ITERATIONS` in `Code.gs`:

```javascript
// Enrich kode shuttle hanya untuk booking dalam jendela ini (ms).
var ENRICH_BEFORE_MS = 24 * 3600 * 1000;   // sampai 24 jam setelah berangkat
var ENRICH_AHEAD_MS = 48 * 3600 * 1000;    // sampai 48 jam sebelum berangkat
```

- [ ] **Step 2: Add credential gate + token minter** (place in a new "AO Shuttle API" section, e.g. just above the `/* GitHub */` section):

```javascript
/* --------------------------- AO Shuttle API ---------------------------- */

function aoCredsComplete_() {
  var p = PropertiesService.getScriptProperties();
  return !!(p.getProperty('AOSHUTTLE_CLIENT_ID') &&
            p.getProperty('AOSHUTTLE_CLIENT_SECRET') &&
            p.getProperty('AOSHUTTLE_TOKEN_BASE') &&
            p.getProperty('AOSHUTTLE_API_BASE'));
}

/** Mint access token via client_credentials. Returns string or null. */
function getAoToken_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('AOSHUTTLE_TOKEN_BASE') + '/client_token.php';
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: {
        grant_type: 'client_credentials',
        client_id: p.getProperty('AOSHUTTLE_CLIENT_ID'),
        client_secret: p.getProperty('AOSHUTTLE_CLIENT_SECRET')
      },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      Logger.log('getAoToken_ HTTP %s', res.getResponseCode());
      return null;
    }
    var json = JSON.parse(res.getContentText());
    var tok = (json.tiketux && json.tiketux.result && json.tiketux.result.access_token) ||
              json.access_token || null;
    if (!tok) Logger.log('getAoToken_: access_token tidak ditemukan di response.');
    return tok;
  } catch (e) {
    Logger.log('getAoToken_ error: %s', e);
    return null;
  }
}
```

- [ ] **Step 3: Verify it parses + mints in the Apps Script editor**

Set the 4 Script Properties (Project Settings → Script Properties) to the Task 1 values. In the editor, temporarily add and run:
```javascript
function _testToken() { Logger.log('TOKEN len=%s', (getAoToken_() || '').length); }
```
Run `_testToken`, open Executions/Logs.
Expected: `TOKEN len=` followed by a non-zero number (e.g. 40). Delete `_testToken` after.

- [ ] **Step 4: Commit**

```bash
cd ao-tix && git add apps-script/Code.gs
git commit -m "Code.gs: getAoToken_ (client_credentials) + enrich window constants"
```

---

### Task 4: `Code.gs` — `fetchShuttleCode_`

**Files:**
- Modify: `ao-tix/apps-script/Code.gs` (in the "AO Shuttle API" section, after `getAoToken_`)

**Interfaces:**
- Consumes: `getAoToken_()` output (token string); Script Property `AOSHUTTLE_API_BASE`.
- Produces: `fetchShuttleCode_(bookingCode, token)` → `{ pergi: string, pulang: string }` (empty strings when absent/failed).

- [ ] **Step 1: Add the function**

```javascript
/** Ambil kode kendaraan untuk satu booking. Return {pergi, pulang} (string, '' bila tak ada). */
function fetchShuttleCode_(bookingCode, token) {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('AOSHUTTLE_API_BASE') + '/api-whitelabel/reservasi/detail';
  try {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: { kodebooking: bookingCode },
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return { pergi: '', pulang: '' };
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
```

- [ ] **Step 2: Verify against the real booking in the editor**

Temporarily add and run:
```javascript
function _testDetail() {
  var t = getAoToken_();
  Logger.log(JSON.stringify(fetchShuttleCode_('BAOS2605300P1Z', t)));
}
```
Expected log: `{"pergi":"...","pulang":""}` — no exception. (`pergi` may be `""` until armada assigned; the point is no error and correct shape.) Delete `_testDetail` after.

- [ ] **Step 3: Commit**

```bash
cd ao-tix && git add apps-script/Code.gs
git commit -m "Code.gs: fetchShuttleCode_ ambil kode_kendaraan dari /reservasi/detail"
```

---

### Task 5: `Code.gs` — `enrichShuttleCodes_` + wire into `syncTickets`

**Files:**
- Modify: `ao-tix/apps-script/Code.gs` (add `enrichShuttleCodes_`; insert one call in `syncTickets`)

**Interfaces:**
- Consumes: `aoCredsComplete_()`, `getAoToken_()`, `fetchShuttleCode_()`, `ENRICH_BEFORE_MS`, `ENRICH_AHEAD_MS`.
- Produces: mutates ticket objects in place, adding `shuttleCodePergi` / `shuttleCodePulang` where non-empty.

- [ ] **Step 1: Add `enrichShuttleCodes_`** (in the "AO Shuttle API" section):

```javascript
/** Untuk booking dalam jendela & belum punya kode: isi shuttleCodePergi/Pulang. In-place. */
function enrichShuttleCodes_(tickets) {
  if (!aoCredsComplete_()) { Logger.log('Enrich dilewati: creds AO Shuttle belum lengkap.'); return; }
  var now = Date.now();
  var due = tickets.filter(function (t) {
    if (t.shuttleCodePergi) return false;            // sudah ada
    if (!t.departISO) return false;
    var dep = Date.parse(t.departISO);
    if (isNaN(dep)) return false;
    return dep >= now - ENRICH_BEFORE_MS && dep <= now + ENRICH_AHEAD_MS;
  });
  if (!due.length) return;
  var token = getAoToken_();
  if (!token) { Logger.log('Enrich dilewati: gagal mint token.'); return; }
  var filled = 0;
  due.forEach(function (t) {
    var c = fetchShuttleCode_(t.bookingCode, token);
    if (c.pergi) { t.shuttleCodePergi = c.pergi; filled++; }
    if (c.pulang) { t.shuttleCodePulang = c.pulang; }
  });
  Logger.log('Enrich: %s booking dicek, %s dapat kode shuttle.', due.length, filled);
}
```

- [ ] **Step 2: Call it in `syncTickets` — BEFORE the hash**

In `Code.gs`, change the start of `syncTickets` from:
```javascript
  var props = PropertiesService.getScriptProperties();
  var tickets = collectTickets_();

  // Hash HANYA atas data tiket
```
to:
```javascript
  var props = PropertiesService.getScriptProperties();
  var tickets = collectTickets_();
  enrichShuttleCodes_(tickets);   // isi kode shuttle (no-op bila creds belum di-set)

  // Hash HANYA atas data tiket
```

- [ ] **Step 3: Manual end-to-end run**

In the Apps Script editor run `syncTickets`. Open Logs.
Expected: a line `Enrich: N booking dicek, M dapat kode shuttle.` and the run completes without throwing. If `M > 0`, a push to GitHub occurs (hash changed); if data unchanged, `Tidak ada perubahan` is logged. Either is acceptable — confirm no exception.

- [ ] **Step 4: Confirm fail-safe — clear one cred, run again**

Temporarily delete `AOSHUTTLE_CLIENT_ID` in Script Properties, run `syncTickets`.
Expected: log `Enrich dilewati: creds AO Shuttle belum lengkap.` and a normal sync (no exception). Restore the property afterward.

- [ ] **Step 5: Commit**

```bash
cd ao-tix && git add apps-script/Code.gs
git commit -m "Code.gs: enrichShuttleCodes_ + panggil di syncTickets (fail-safe, additive)"
```

---

### Task 6: Web app — display shuttle code

**Files:**
- Modify: `ao-tix/assets/app.js` (add `shuttleText`; edit `cardHtml` card-meta; edit `detailHtml` Keberangkatan section)
- Modify: `ao-tix/assets/style.css` (add `.shuttle` style)

**Interfaces:**
- Consumes: ticket fields `shuttleCodePergi`, `shuttleCodePulang` produced by Task 5.
- Produces: visible "🚐 AOLV0xx" in the card and a "Kode Shuttle" row in the detail view.

- [ ] **Step 1: Add the helper** in `assets/app.js`, immediately after `routeFromPax` (ends at the line `}` after `return p ? p.route : '';`):

```javascript
function shuttleText(t) {
  var a = t.shuttleCodePergi || '', b = t.shuttleCodePulang || '';
  if (a && b && a !== b) return a + ' / ' + b;
  return a || b || '';
}
```

- [ ] **Step 2: Show it in the card meta.** In `cardHtml`, change:
```javascript
      '<div class="card-meta">' +
        '<span class="kode">' + esc(t.bookingCode || '') + '</span>' +
        '<span>' + pax + ' penumpang</span>' +
      '</div>' +
```
to:
```javascript
      '<div class="card-meta">' +
        '<span class="kode">' + esc(t.bookingCode || '') + '</span>' +
        (shuttleText(t) ? '<span class="shuttle">🚐 ' + esc(shuttleText(t)) + '</span>' : '') +
        '<span>' + pax + ' penumpang</span>' +
      '</div>' +
```

- [ ] **Step 3: Show it in the detail "Keberangkatan" section.** In `detailHtml`, change:
```javascript
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
```
to:
```javascript
    section('Keberangkatan', kv([
      ['Dari', esc(t.departurePoint)],
      ['Alamat', esc(t.departureAddress)],
      ['Maps', mapLink(t.departureMaps)],
      ['Tujuan', esc(t.destinationPoint)],
      ['Alamat', esc(t.destinationAddress)],
      ['Maps', mapLink(t.destinationMaps)],
      ['Tanggal', esc(t.departDate)],
      ['Jam', esc(t.departTime)]
    ].concat(shuttleText(t)
      ? [['Kode Shuttle', '<span class="kode">' + esc(shuttleText(t)) + '</span>']]
      : []))) +
```

- [ ] **Step 4: Add the badge style.** Append to `assets/style.css`:
```css
.shuttle { font-weight: 600; }
```

- [ ] **Step 5: Manual visual check with synthetic data**

In a browser devtools console on the running app (or temporarily), confirm the helper:
```javascript
shuttleText({ shuttleCodePergi: 'AOLV021' })            // → "AOLV021"
shuttleText({ shuttleCodePergi: 'AOLV021', shuttleCodePulang: 'AOLV022' }) // → "AOLV021 / AOLV022"
shuttleText({})                                          // → ""
```
Expected: the three outputs above. Then load the app: a ticket WITH a code shows "🚐 AOLV0xx" in its card and a "Kode Shuttle" row in detail; a ticket WITHOUT one shows neither (no empty row).

- [ ] **Step 6: Commit and push**

```bash
cd ao-tix && git add assets/app.js assets/style.css
git commit -m "Web: tampilkan kode shuttle (AOLV) di kartu & detail tiket"
git pull --rebase && git push
```
Expected: push succeeds (rebase first if the bot pushed `tickets.enc.json`).

---

## Self-Review

**Spec coverage:**
- Setup capture of `client_id`/`client_secret`/`base_host_api` → Task 1. ✔
- `get_booking_detail.sh` → Task 2. ✔
- `getAoToken_` / `fetchShuttleCode_` / `enrichShuttleCodes_` + wiring → Tasks 3, 4, 5. ✔
- Enrich window (now−24h … now+48h) → Task 3 constants, Task 5 filter. ✔
- Fields `shuttleCodePergi`/`shuttleCodePulang`, set only when non-empty → Task 4 trim + Task 5 conditional set. ✔
- Gating when creds incomplete → Task 3 `aoCredsComplete_`, Task 5 early return (verified Task 5 Step 4). ✔
- Fail-safe error handling (token/detail) → Tasks 3/4 try-catch + muteHttpExceptions. ✔
- Hash after enrichment → Task 5 Step 2 inserts before the hash block. ✔
- Web display in card + detail → Task 6. ✔
- Secrets never committed → Task 2 `.gitignore` + Step 5 check. ✔

**Placeholder scan:** `REPLACE_*` appears only as capture inputs in Task 1/2 (genuine user-supplied secrets), not as unfinished plan content. No TBD/TODO.

**Type consistency:** `getAoToken_()→string|null`; `fetchShuttleCode_(bookingCode, token)→{pergi,pulang}`; `enrichShuttleCodes_(tickets)` mutates; `shuttleText(t)→string`. Field names `shuttleCodePergi`/`shuttleCodePulang` and Script Property names `AOSHUTTLE_*` are identical across Tasks 3–6. ✔
