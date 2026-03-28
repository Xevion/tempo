import { flavors } from "@catppuccin/palette";
import ansis from "ansis";

const mocha = flavors.mocha.colors;

/**
 * Catppuccin Mocha theme via ansis.extend().
 *
 * Names that collide with ansis builtins (red, green, yellow, blue) are
 * prefixed: catRed, catGreen, catYellow, catBlue. All other Catppuccin
 * names are used as-is.
 */
export const c = ansis.extend({
	rosewater: mocha.rosewater.hex,
	flamingo: mocha.flamingo.hex,
	pink: mocha.pink.hex,
	mauve: mocha.mauve.hex,
	catRed: mocha.red.hex,
	maroon: mocha.maroon.hex,
	peach: mocha.peach.hex,
	catYellow: mocha.yellow.hex,
	catGreen: mocha.green.hex,
	teal: mocha.teal.hex,
	sky: mocha.sky.hex,
	sapphire: mocha.sapphire.hex,
	catBlue: mocha.blue.hex,
	lavender: mocha.lavender.hex,
	text: mocha.text.hex,
	subtext1: mocha.subtext1.hex,
	subtext0: mocha.subtext0.hex,
	overlay2: mocha.overlay2.hex,
	overlay1: mocha.overlay1.hex,
	overlay0: mocha.overlay0.hex,
	surface2: mocha.surface2.hex,
	surface1: mocha.surface1.hex,
	surface0: mocha.surface0.hex,
	base: mocha.base.hex,
	mantle: mocha.mantle.hex,
	crust: mocha.crust.hex,
});
