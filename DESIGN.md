# DESIGN.md — socket-golf

Pixel-art browser mini-golf game. No accounts, no app store, just room codes and real-time physics.

## Color Palette

| Token | Hex | Usage |
|---|---|---|
| `--bg-dark` | `#1a1a2e` | Page background, UI chrome background |
| `--bg-canvas` | `#16213e` | Course canvas background (non-fairway area) |
| `--grass` | `#2d8a4e` | Fairway/fairway fill |
| `--grass-dark` | `#1e5e34` | Rough/out-of-bounds |
| `--wall` | `#5a5a6e` | Wall/obstacle bodies |
| `--wall-light` | `#7a7a8e` | Wall highlight edge |
| `--sand` | `#c4a45a` | Tee area, bunkers |
| `--water` | `#1a3a5c` | Water hazard (v2) |
| `--ball` | `#f0f0f0` | Ball fill |
| `--ball-outline` | `#888888` | Ball stroke/outline |
| `--hole` | `#0a0a0a` | Hole center |
| `--text-primary` | `#e0e0e0` | Headings, turn indicator, active text |
| `--text-secondary` | `#888888` | HUD scores, room code, labels |
| `--text-muted` | `#555555` | Disabled text, inactive player names |
| `--accent` | `#4ecdc4` | Active player highlight, button hover, focus ring |
| `--success` | `#6fcf97` | Par/E score highlight |
| `--danger` | `#eb5757` | Over-par score, error text, disconnect indicator |
| `--power-fill` | `#f2994a` | Power meter filled segments |
| `--power-empty` | `#2a2a3e` | Power meter empty segments |

Contrast rule: body text (`--text-primary`) on background (`--bg-dark`) must exceed 4.5:1 contrast ratio.

## Typography

**Primary (headings, HUD, title):** `"Press Start 2P"` — Google Fonts, 400 weight.
**Secondary (body, scores, labels):** `"Courier New"`, monospace — system font, zero dependency.

Font sizes (at 1x scale, Phaser pixelArt mode):
- Title: 16px `Press Start 2P`
- Turn indicator: 10px `Press Start 2P`
- HUD scores: 12px `Courier New`
- Room code: 14px `Courier New`
- Button text: 10px `Courier New`, uppercase, letter-spacing 2px

## Phaser Configuration

```js
{
  type: Phaser.CANVAS,
  pixelArt: true,
  roundPixels: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  backgroundColor: '#1a1a2e'
}
```

Canvas internal resolution: 640x360 (16:9).

## Anti-Slop Rules

- No rounded corners — sharp rectangles matching pixel grid
- No gradients or shadows — flat colors only
- No card containers — the course IS the content
- No emoji in UI — pixel-art sprites for all game elements
- No centered text blocks — left-aligned or course-relative positioning
- One job per screen: Lobby = join. Game = play. Scoreboard = see results.
