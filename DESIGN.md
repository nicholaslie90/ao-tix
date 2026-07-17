# Design

Visual system for E-Tiket AO Shuttle. Source of truth: tokens in `assets/style.css` (`:root` = light, `[data-theme="dark"]` = dark).

## Theme

Light is the default (curbside phone-in-daylight use); dark is opt-in via toggle or OS preference, persisted in `localStorage` (`aoshuttle_theme`). An inline `<head>` script in `index.html` sets `data-theme` before first paint.

## Color

OKLCH throughout. Restrained strategy: cool navy-tinted neutrals + one teal accent (from the AO logomark), amber for warnings only.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `oklch(97.6% 0.005 190)` | `oklch(20% 0.015 270)` | Body |
| `--panel` | white | `oklch(24% 0.015 270)` | Cards, modal, topbar |
| `--panel-2` | `oklch(95.4% 0.007 190)` | `oklch(28.5% 0.015 270)` | Inputs, hover, neutral badges |
| `--border` | `oklch(90% 0.01 195)` | `oklch(33% 0.015 270)` | Hairlines |
| `--text` | `oklch(26% 0.03 275)` | `oklch(93% 0.01 250)` | Ink |
| `--muted` | `oklch(50% 0.025 265)` | `oklch(70% 0.02 255)` | Secondary text (AA on panel & panel-2) |
| `--accent` | `oklch(52% 0.1 172)` | `oklch(74% 0.115 172)` | Primary action, links, OTP, shuttle codes, "soon" badge |
| `--accent-ink` | white | `oklch(20% 0.02 270)` | Text on accent |
| `--warn` | `oklch(53% 0.12 65)` | `oklch(80% 0.13 80)` | Missing-ticket warnings (with `--warn-tint` bg) |
| `--danger` | `oklch(53% 0.19 27)` | `oklch(70% 0.17 25)` | Errors only |

All text pairs verified ≥5.2:1 (WCAG AA, most AAA). Tinted backgrounds are the accent/warn color at 10–13% alpha (`--accent-tint`, `--warn-tint`); never put gray text on them — use the matching ink color.

## Typography

System sans stack, one family. Fixed rem/px scale: 11px badges, 12px section labels (the modal's uppercase h3 is the only uppercase), 13–14px meta/body, 15–16px emphasis, 17–18px card route / page title, 22px modal route. Codes (booking, shuttle, OTP, prices) use `ui-monospace` + `tabular-nums`.

## Shape & depth

`--radius: 14px` cards, `--radius-sm: 10px` controls, 18px modal/login/mapbox, 20px QR lightbox card, 999px badges. Two shadows only: `--shadow-1` (resting card) and `--shadow-2` (hover, overlays). Borders stay 1px hairlines; warn state tints the border via `color-mix`, never a side-stripe.

## Motion

Ease-out only (`--ease-out: cubic-bezier(.22,1,.36,1)`). 150–250ms: card hover lift, button press scale(.98), `popIn`/`fadeIn` on modal/mapbox (CSS animations, so they fire on `hidden` removal). The QR lightbox swipe (JS, in `app.js`) is the one flourish. Every animation has a `prefers-reduced-motion: reduce` disable at the bottom of `style.css`; keep new animations registered there.

## Components

- **Topbar**: sticky, translucent panel + `backdrop-filter: blur(10px)`, borderless ghost icon buttons (min 40px tall), SVG icons (stroke-2 round, feather-style) — no emoji in chrome; emoji are allowed in content (🚐, ⚠️, 🎫).
- **Cards**: panel + hairline + shadow-1; hover lifts 1px with accent-tinted border. Whole card is the tap target.
- **Badges**: filled pills, no borders. Neutral = panel-2/muted; "soon" = accent-tint/accent.
- **Warnings**: banner and card chip both use `--warn-tint` bg + `--warn` ink; day headers of incomplete days recolor to `--warn`.
- **QR surfaces**: always pure white with dark modules, `image-rendering: pixelated` — scannability beats theming; in dark mode QR thumbnails get a hairline border.
- **Overlays**: `--backdrop` scrim (opaque black 85% for lightbox), z-scale: topbar 5 → modal 20 → lightbox 40 → mapbox 50.
