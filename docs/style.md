# Visual style: Blood Angels

Strategium's README assets follow a Blood Angels palette: dark crimson, deep night, gold and bone. This file is the single source for those colours; change a colour here first, then in every place listed under [Where it lives](#where-it-lives). "Blood Angels" only names the palette: the project is unofficial and uses no Games Workshop artwork, logos or fonts (see the trademark note at the end of the README).

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
| Ember | `#D9535E` | Blood lightened: red text on Night reaches 4.5:1 (cockpit) |
| Ash | `#907A74` | Bone darkened toward Surface: muted text on Night reaches 4.5:1 (cockpit) |

The light banner swaps the roles: Bone background, Vellum panel, Blood title, Old gold rules, Surface subtitle and motto (Old gold on Vellum is only 3:1, too low for 13 px text).

## Type and marks

- Titles: Cinzel (OFL), converted to paths by `tools/banner/banner.ts` (`bun tools/banner/banner.ts path/to/Cinzel[wght].ttf docs`), so no font loads at view time.
- Diagrams: `Georgia, serif`.
- Icons: Material Design Icons (`docs/icons/`, licence in `docs/icons/LICENSE`) filled with Gold. No Games Workshop artwork, logos or fonts.

## Voice

Station names, agent names and alerts carry the theme. Section headings, tickets, commit messages and merge requests stay plain and professional.

## Where it lives

| Place | What |
|---|---|
| `tools/banner/banner.ts` (`THEMES`) | `docs/banner-dark.svg`, `docs/banner-light.svg` |
| `README.md`, `README.es.md` | badge colours, the mermaid `init`, `classDef` and `linkStyle` lines |
| `docs/icons/*.svg` | the `fill` attribute |
| `extensions/strategium/themes.ts` (`THEMES['blood-angels']`) | the cockpit's default theme |
| `README.md`, `README.es.md` (release badge `logo=`) | `docs/icons/skull.svg` URL-encoded in base64; a grep for the hex does not find it. After changing Gold, re-encode: `bun -e "console.log(encodeURIComponent('data:image/svg+xml;base64,'+require('fs').readFileSync('docs/icons/skull.svg').toString('base64')).replace(/%3A/g,':').replace(/%3B/g,';').replace(/%2C/g,','))"` |

The cockpit's default `blood-angels` theme uses this palette: the Night background, Gold and Bone, with Ember (red text) and Ash (muted text) from Derived, so text keeps 4.5:1 on Night. The other cockpit themes (`ultramarines`, `dark-angels`, `cogitator`) have their own palettes.
