---
name: strategium-ui
description: Use for UI squads in a Strategium run (build, redesign or review a screen, page or dialog); fixed context → direction → build → copy → review → verify pass over public UI skills. Briefs for battle-brother UI squads name it.
---

# Strategium UI pass

One pass in a fixed order over public skills. Read each skill when its step starts, not before. Missing skill → stop and report it (install: `/skill:strategium-setup`); never skip a step silently.

| Step | Skill | Role |
|---|---|---|
| 1 Context | repo + `ui-ux-pro-max` | Stack, existing tokens and components, device |
| 2 Direction | `frontend-design` + `ui-ux-pro-max` | Palette, type, layout, principles |
| 3 Build | `frontend-ui-engineering` | Implementation with every state |
| 4 Copy | `ux-copy` | Labels, CTAs, errors, empty states, confirmations |
| 5 Review | `ux-heuristics`, `accessibility`, `web-design-guidelines` | Usability, WCAG 2.2 AA, interface rules |
| 6 Verify | browser | Screenshots at the device resolution, fix, re-check |

Redesign: step 5 first (audit), then 2-6 on its findings. Pure review: 1 and 5.

## 1. Context (never skip)
- Detect the stack from the repo; never assume it.
- Existing design system first (theme files, CSS variables, Tailwind config, component library). Existing tokens and components win; never add a second convention.
- Device and context come from the brief or the theatre (resolution, touch, distance). Touch UI: targets ≥ 44x44 px, no hover-only affordances.

## 2. Direction
- `frontend-design`: compact plan (4-6 named colours, type roles, ASCII wireframe, principles); drop generic defaults. Hero advice is for landing pages only; in app UI the first screen is the task.
- `ui-ux-pro-max`: run its `scripts/search.py` from the skill directory (`--design-system`, `--domain ux`, `--stack <stack>`). Output is suggestions; ignore its landing-page `PATTERN` block for app screens. Never `--persist`/`--force` without the user's OK.
- Generated tokens become the base only when the repo has no design system.

## 3. Build
`frontend-ui-engineering`: component structure, responsive, a11y basics. Every screen has loading, empty, error and disabled states. Tests first as the brief's TDD skill says.

## 4. Copy
`ux-copy`: verb + noun CTAs; error = what happened + how to fix; confirmations name the action. One term per concept. UI language follows the product's i18n files, not the chat language.

## 5. Review
Run all three, merge into one list by severity, one finding → one fix:
- `ux-heuristics`: severity 0-4, score /10.
- `accessibility`: contrast, focus, names/roles, keyboard, target size; axe/Lighthouse on the rendered page when possible.
- `web-design-guidelines`: `file:line` findings.

## 6. Verify
Render the real screen (dev/preview server) at the device resolution, screenshot before/after into the OS temp dir, re-run failed checks after fixing.

## Report (in the squad's final report)
Design decisions (one table), findings by severity with the fix applied, screenshot paths, what was left out and why.
