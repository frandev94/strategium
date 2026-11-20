# Visual style: Blood Angels

Strategium's README assets follow a Blood Angels palette: dark crimson, deep night, gold and bone. This file is the single source for those colours; change a colour here first, then in every place listed under [Where it lives](#where-it-lives).

## Palette

| Token | Hex | Use |
|---|---|---|
| Blood | `#791E29` | seals, the release badge, red accents |
| Night | `#180D10` | background: banner, agent nodes, badge labels |
| Surface | `#281216` | panels: banner inner panel, stations, edge labels |
| Gold | `#C5A15A` | titles, rules, strokes, icons |
| Bone | `#E8DDC5` | text on Night or Surface |

### Derived

Only where the base palette cannot work; derive new values from it, never pick unrelated ones.

| Token | Hex | Why |
|---|---|---|
| Wound | `#B8323F` | Blood lightened: thin return arrows must read on GitHub's dark page |
| Vellum | `#DCCBA8` | Bone darkened: inner panel of the light banner |
| Old gold | `#8C6D2E` | Gold darkened: gold on Bone needs contrast in the light banner |

The light banner swaps the roles: Bone background, Vellum panel, Blood title, Old gold rules, Surface subtitle.

## Type and marks

- Titles: Cinzel (OFL), converted to paths by `tools/banner/banner.py`, so no font loads at view time.
- Diagrams: `Georgia, serif`.
- Icons: Material Design Icons (`docs/icons/`, licence in `docs/icons/LICENSE`) filled with Gold. No Games Workshop artwork, logos or fonts.

## Voice

Station names, agent names and alerts carry the theme. Section headings, tickets, commit messages and merge requests stay plain and professional.

## Where it lives

| Place | What |
|---|---|
| `tools/banner/banner.py` (`THEMES`) | `docs/banner-dark.svg`, `docs/banner-light.svg` |
| `README.md`, `README.es.md` | badge colours, the mermaid `init`, `classDef` and `linkStyle` lines |
| `docs/icons/*.svg` | the `fill` attribute |

The cockpit (`extensions/strategium/cockpit.ts`, `HEX`) has its own terminal palette and does not follow this file.
