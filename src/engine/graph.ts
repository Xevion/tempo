import { GraphError, type Task } from "./types.ts";

export type TaskInit = Partial<Omit<Task, "name" | "body">> &
	Pick<Task, "name" | "body">;

export function task(init: TaskInit): Task {
	return {
		needs: [],
		after: [],
		tags: [],
		requires: [],
		persistent: false,
		...init,
	};
}

/**
 * The task registry plus the graph operations a run needs.
 *
 * Selection is separate from execution: the whole graph is knowable before
 * anything spawns, which is what makes `--dry-run` and static validation real.
 */
export class Graph {
	readonly tasks: ReadonlyMap<string, Task>;

	constructor(tasks: Task[]) {
		const map = new Map<string, Task>();
		for (const t of tasks) {
			if (map.has(t.name)) throw new GraphError(`duplicate task: ${t.name}`);
			map.set(t.name, t);
		}
		this.tasks = map;
		this.validate();
	}

	private validate(): void {
		for (const t of this.tasks.values()) {
			// A persistent task never exits, so its lock would never be released.
			if (t.lock && t.persistent) {
				throw new GraphError(
					`task "${t.name}" cannot be both persistent and locked`,
				);
			}
			for (const dep of [...t.needs, ...t.after]) {
				if (!this.tasks.has(dep)) {
					throw new GraphError(
						`task "${t.name}" references unknown task "${dep}"`,
					);
				}
			}
			// A persistent task never exits, so needing one is a hang with no runtime symptom.
			for (const dep of t.needs) {
				if (this.tasks.get(dep)?.persistent && !t.persistent) {
					throw new GraphError(
						`task "${t.name}" needs "${dep}", which is persistent and never exits`,
					);
				}
			}
		}
	}

	get(name: string): Task {
		const found = this.tasks.get(name);
		if (!found) throw new GraphError(`unknown task: ${name}`);
		return found;
	}

	/** Resolve a run set from a predicate, pulling `needs` transitively. */
	select(predicate: (task: Task) => boolean): Set<string> {
		const chosen = new Set<string>();
		const pull = (name: string): void => {
			if (chosen.has(name)) return;
			chosen.add(name);
			for (const dep of this.tasks.get(name)?.needs ?? []) pull(dep);
		};
		for (const t of this.tasks.values()) if (predicate(t)) pull(t.name);
		return chosen;
	}

	selectByTag(tag: string): Set<string> {
		return this.select((t) => t.tags.includes(tag));
	}

	selectByName(names: string[]): Set<string> {
		for (const n of names) this.get(n);
		const wanted = new Set(names);
		return this.select((t) => wanted.has(t.name));
	}

	/** Edges applying within a run set: every `needs`, plus `after` already present. */
	edgesWithin(runSet: ReadonlySet<string>): Map<string, Set<string>> {
		const edges = new Map<string, Set<string>>();
		for (const name of runSet) {
			const t = this.tasks.get(name);
			if (!t) continue;
			const deps = new Set(t.needs);
			for (const a of t.after) if (runSet.has(a)) deps.add(a);
			edges.set(name, deps);
		}
		return edges;
	}

	/** The cycle path that closes the loop, or null when acyclic. */
	findCycle(runSet: ReadonlySet<string>): string[] | null {
		const edges = this.edgesWithin(runSet);
		const state = new Map<string, "open" | "closed">();
		const stack: string[] = [];

		const visit = (name: string): string[] | null => {
			const seen = state.get(name);
			if (seen === "closed") return null;
			if (seen === "open") return [...stack.slice(stack.indexOf(name)), name];
			state.set(name, "open");
			stack.push(name);
			for (const dep of edges.get(name) ?? []) {
				const cycle = visit(dep);
				if (cycle) return cycle;
			}
			stack.pop();
			state.set(name, "closed");
			return null;
		};

		for (const name of runSet) {
			const cycle = visit(name);
			if (cycle) return cycle;
		}
		return null;
	}

	/** Topological layers, where each layer may run concurrently. */
	layers(runSet: ReadonlySet<string>): string[][] {
		const cycle = this.findCycle(runSet);
		if (cycle) {
			throw new GraphError(`dependency cycle: ${cycle.join(" -> ")}`);
		}

		const edges = this.edgesWithin(runSet);
		const placed = new Set<string>();
		const out: string[][] = [];

		while (placed.size < runSet.size) {
			const layer = [...runSet]
				.filter((n) => !placed.has(n))
				.filter((n) => [...(edges.get(n) ?? [])].every((d) => placed.has(d)))
				.sort();
			if (layer.length === 0) {
				throw new GraphError("cycle escaped detection");
			}
			for (const n of layer) placed.add(n);
			out.push(layer);
		}
		return out;
	}
}
