// Colour themes of the extension's UI (today: the cockpit). To add one, copy a block and pick its colours;
// `bun run check` rejects a theme with a missing or misspelt tone, and the tests reject a colour Bun.color cannot read
// or, on a theme with a background, a text tone under 4.5:1 on it.
// Tones: gold (frame, seals, attention), parchment (text), green (running and done), red (failed, clock at 100 %),
// purple (the inquisitor), iron (idle and muted text). bg is optional: without it the terminal keeps its own background.
export type Tone = "gold" | "parchment" | "green" | "red" | "purple" | "iron";
export type Theme = Record<Tone, string> & { bg?: string };

export const THEMES = {
	// Blood Angels, the palette of docs/style.md.
	"blood-angels": {
		bg: "#180D10", // Night
		gold: "#C5A15A",
		parchment: "#E8DDC5", // Bone
		green: "#E8DDC5", // no green in the heraldry: running and done read as Bone
		red: "#D9535E", // Blood lightened for text
		purple: "#A07CC8",
		iron: "#907A74",
	},
	// Ultramarines: deep blue, gold and white; running and done read as a pale blue.
	ultramarines: { bg: "#0B1528", gold: "#D4B062", parchment: "#E6ECF5", green: "#8FBCE8", red: "#E3646A", purple: "#B39DDB", iron: "#7F8DA6" },
	// Dark Angels: dark green with bone robes; the one Chapter whose running tone is a true green.
	"dark-angels": { bg: "#0B1A12", gold: "#C9B27A", parchment: "#E4DCC4", green: "#72C27A", red: "#E0605A", purple: "#AE92D6", iron: "#7E8C80" },
	// The original Mechanicus cogitator: bright green on the terminal's own background.
	cogitator: { gold: "#C9A227", parchment: "#E6D8B5", green: "#4CFF7A", red: "#A4161A", purple: "#7B2CBF", iron: "#5A5A5A" },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeName = "blood-angels";
export const isTheme = (name: string): name is ThemeName => Object.hasOwn(THEMES, name);
