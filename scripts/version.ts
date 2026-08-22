/** Lexicographic dotted-version comparison: is `actual` >= `min`? */
export function versionAtLeast(actual: string, min: string): boolean {
	const a = actual.split(".").map(Number);
	const m = min.split(".").map(Number);
	for (let i = 0; i < m.length; i++) {
		const av = a[i] ?? 0;
		const mv = m[i] ?? 0;
		if (av !== mv) return av > mv;
	}
	return true;
}
