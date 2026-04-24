/**
 * Polygon boolean operations for merging overlapping hole regions
 * Uses polyclip-ts (Martinez-Rueda-Feito algorithm)
 */

import type { Geom } from 'polyclip-ts';
import type { Point } from '../utils/polygonUtils';
import { difference, intersection, union } from 'polyclip-ts';
import { aabbIntersects, calculateBoundingBox } from '../utils/polygonUtils';

const TAG = '[DynamicFill:PolygonBoolean]';

/**
 * Convert Point[] to polyclip Ring format (closed polygon)
 */
function pointsToRing(points: Point[]): [number, number][] {
	const ring: [number, number][] = points.map(p => [p.x, p.y]);
	// Close the ring
	ring.push([points[0].x, points[0].y]);
	return ring;
}

/**
 * Convert polyclip Ring back to Point[] (removes closing point)
 */
function ringToPoints(ring: [number, number][]): Point[] {
	return ring.slice(0, -1).map(([x, y]) => ({ x, y }));
}

/**
 * Merge overlapping obstacle polygons using polyclip-ts union.
 *
 * Steps:
 * 1. AABB pre-check to filter impossible intersections
 * 2. Union-find to group overlapping polygons
 * 3. Chain union for each group
 * 4. Return merged non-overlapping polygons
 */
export async function mergeOverlappingObstacles(
	obstacles: Point[][],
	onProgress?: (done: number, total: number) => void,
): Promise<{ merged: Point[][]; unionFailures: number }> {
	if (obstacles.length <= 1)
		return { merged: obstacles, unionFailures: 0 };

	// Single-pass union of all holes — guarantees no overlaps
	try {
		onProgress?.(0, 1);
		const geoms: Geom[] = obstacles.map(pts => [pointsToRing(pts)]);
		const result = union(geoms[0], ...geoms.slice(1));
		const merged: Point[][] = [];
		for (const poly of result) {
			if (poly.length > 0 && poly[0].length >= 4) {
				merged.push(ringToPoints(poly[0]));
			}
		}
		onProgress?.(1, 1);
		console.warn(TAG, `Merge: single-pass union ${obstacles.length} → ${merged.length}`);
		return { merged, unionFailures: 0 };
	}
	catch (e) {
		console.warn(TAG, 'Single-pass union failed, falling back to group merge:', e);
	}

	// Fallback: sweep-line grouping + per-group union
	const n = obstacles.length;
	const bboxes = obstacles.map(pts => calculateBoundingBox(pts));
	const parent = Array.from({ length: n }, (_, i) => i);

	function find(x: number): number {
		while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
		return x;
	}
	function unite(a: number, b: number): void {
		const ra = find(a), rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	}

	const events: { x: number; isStart: boolean; idx: number }[] = [];
	for (let i = 0; i < n; i++) {
		events.push({ x: bboxes[i].minX, isStart: true, idx: i });
		events.push({ x: bboxes[i].maxX, isStart: false, idx: i });
	}
	events.sort((a, b) => a.x - b.x || (a.isStart ? -1 : 1));

	const active = new Set<number>();
	for (const ev of events) {
		if (ev.isStart) {
			for (const j of active) {
				if (aabbIntersects(bboxes[ev.idx], bboxes[j])) unite(ev.idx, j);
			}
			active.add(ev.idx);
		}
		else { active.delete(ev.idx); }
	}

	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, []);
		groups.get(r)!.push(i);
	}

	const merged: Point[][] = [];
	let groupsDone = 0;
	let unionFailed = 0;
	const totalGroups = groups.size;
	for (const indices of groups.values()) {
		if (indices.length === 1) {
			merged.push(obstacles[indices[0]]);
			groupsDone++;
			continue;
		}
		try {
			const geoms: Geom[] = indices.map(idx => [pointsToRing(obstacles[idx])]);
			const current = union(geoms[0], ...geoms.slice(1));
			for (const poly of current) {
				if (poly.length > 0 && poly[0].length >= 4) merged.push(ringToPoints(poly[0]));
			}
		}
		catch (e) {
			unionFailed++;
			for (const idx of indices) merged.push(obstacles[idx]);
		}
		groupsDone++;
		if (groupsDone % 20 === 0) {
			onProgress?.(groupsDone, totalGroups);
			await new Promise<void>(r => setTimeout(r, 0));
		}
	}
	console.warn(TAG, `Merge fallback: ${totalGroups} groups, ${unionFailed} failures, ${merged.length} result`);
	return { merged, unionFailures: unionFailed };
}

export interface ClipMeta {
	rotation: number;
	negateBisector: boolean;
	extraGap: number;
}

export interface ClippedObstacle extends ClipMeta {
	points: Point[];
}

/**
 * Clip obstacles to region with metadata preservation.
 * Computes regionGeom/regionBB once, AABB pre-filters, and tracks source metadata.
 */
export async function clipObstaclesToRegionWithMeta(
	obstacles: Point[][],
	metadata: ClipMeta[],
	region: Point[],
	onProgress?: (done: number, total: number) => void,
	batchSize: number = 50,
): Promise<ClippedObstacle[]> {
	if (obstacles.length === 0)
		return [];

	const regionGeom: Geom = [pointsToRing(region)];
	const regionBB = calculateBoundingBox(region);
	const result: ClippedObstacle[] = [];

	for (let i = 0; i < obstacles.length; i++) {
		try {
			const obsBB = calculateBoundingBox(obstacles[i]);
			if (!aabbIntersects(obsBB, regionBB))
				continue;

			// Fast path: if obstacle AABB is fully inside region AABB, skip intersection
			if (obsBB.minX >= regionBB.minX && obsBB.maxX <= regionBB.maxX
				&& obsBB.minY >= regionBB.minY && obsBB.maxY <= regionBB.maxY) {
				result.push({ points: obstacles[i], ...metadata[i] });
				continue;
			}

			const obsGeom: Geom = [pointsToRing(obstacles[i])];
			const clipped = intersection(regionGeom, obsGeom);

			for (const poly of clipped) {
				if (poly.length > 0 && poly[0].length >= 4) {
					result.push({ points: ringToPoints(poly[0]), ...metadata[i] });
				}
			}
		}
		catch (e) {
			result.push({ points: obstacles[i], ...metadata[i] });
		}

		if ((i + 1) % batchSize === 0) {
			onProgress?.(i + 1, obstacles.length);
			await new Promise<void>(r => setTimeout(r, 0));
		}
	}
	onProgress?.(obstacles.length, obstacles.length);
	return result;
}

/**
 * Merge overlapping holes using sweep-line grouping + per-group union.
 * Non-overlapping holes pass through directly.
 */
export async function unionAllHoles(
	holes: Point[][],
	onProgress?: (done: number, total: number) => void,
): Promise<Point[][]> {
	if (holes.length <= 1)
		return holes;

	const EPS = 2;
	let current = holes;
	const MAX_PASSES = 5;

	for (let pass = 0; pass < MAX_PASSES; pass++) {
		const n = current.length;
		const bboxes = current.map(pts => {
			const bb = calculateBoundingBox(pts);
			return { minX: bb.minX - EPS, minY: bb.minY - EPS, maxX: bb.maxX + EPS, maxY: bb.maxY + EPS };
		});

		const parent = Array.from({ length: n }, (_, i) => i);
		function find(x: number): number {
			while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
			return x;
		}
		function unite(a: number, b: number): void {
			const ra = find(a), rb = find(b);
			if (ra !== rb) parent[ra] = rb;
		}

		const events: { x: number; isStart: boolean; idx: number }[] = [];
		for (let i = 0; i < n; i++) {
			events.push({ x: bboxes[i].minX, isStart: true, idx: i });
			events.push({ x: bboxes[i].maxX, isStart: false, idx: i });
		}
		events.sort((a, b) => a.x - b.x || (a.isStart ? -1 : 1));

		const active = new Set<number>();
		for (const ev of events) {
			if (ev.isStart) {
				for (const j of active) {
					if (aabbIntersects(bboxes[ev.idx], bboxes[j])) unite(ev.idx, j);
				}
				active.add(ev.idx);
			}
			else { active.delete(ev.idx); }
		}

		const groups = new Map<number, number[]>();
		for (let i = 0; i < n; i++) {
			const r = find(i);
			if (!groups.has(r)) groups.set(r, []);
			groups.get(r)!.push(i);
		}

		let needUnion = 0;
		let unionFailed = 0;
		for (const indices of groups.values()) {
			if (indices.length > 1) needUnion++;
		}

		if (needUnion === 0) {
			console.warn(TAG, `UnionHoles pass ${pass}: ${n} holes, no overlaps, done`);
			break;
		}

		const merged: Point[][] = [];
		let groupsDone = 0;
		const totalGroups = groups.size;
		for (const indices of groups.values()) {
			if (indices.length === 1) {
				merged.push(current[indices[0]]);
				groupsDone++;
				continue;
			}

			try {
				const geoms: Geom[] = indices.map(idx => [pointsToRing(current[idx])]);
				const result = union(geoms[0], ...geoms.slice(1));
				let added = 0;
				for (const poly of result) {
					if (poly.length > 0 && poly[0].length >= 4) {
						merged.push(ringToPoints(poly[0]));
						added++;
					}
				}
				if (added === 0) {
					console.warn(TAG, `UnionHoles pass ${pass}: group of ${indices.length} produced 0 polygons, keeping originals`);
					for (const idx of indices) merged.push(current[idx]);
				}
			}
			catch (e) {
				console.warn(TAG, `UnionHoles pass ${pass}: tree-merge for failed group of ${indices.length}`);
				let pool: Geom[] = indices.map(idx => [pointsToRing(current[idx])]);
				const MERGE_SIZE = 20;
				while (pool.length > 1) {
					const next: Geom[] = [];
					for (let p = 0; p < pool.length; p += MERGE_SIZE) {
						const batch = pool.slice(p, p + MERGE_SIZE);
						if (batch.length === 1) { next.push(batch[0]); continue; }
						try {
							next.push(union(batch[0], ...batch.slice(1)));
						}
						catch (_) {
							// Fallback to pairwise for this batch
							let acc = batch[0];
							for (let k = 1; k < batch.length; k++) {
								try { acc = union(acc, batch[k]); }
								catch (__) { next.push(acc); acc = batch[k]; }
							}
							next.push(acc);
						}
					}
					if (next.length >= pool.length) break;
					pool = next;
				}
				for (const g of pool) {
					for (const poly of g) {
						if (poly.length > 0 && poly[0].length >= 4) merged.push(ringToPoints(poly[0]));
					}
				}
			}
			groupsDone++;
			if (groupsDone % 10 === 0) {
				onProgress?.(groupsDone, totalGroups);
				await new Promise<void>(r => setTimeout(r, 0));
			}
		}

		console.warn(TAG, `UnionHoles pass ${pass}: ${n} → ${merged.length} (${needUnion} groups, ${unionFailed} failed)`);

		if (merged.length >= current.length) {
			current = merged;
			break;
		}
		// Early exit if reduction < 5%
		const reduction = (n - merged.length) / n;
		if (reduction < 0.05 && pass > 0) {
			console.warn(TAG, `UnionHoles: reduction ${(reduction * 100).toFixed(1)}% < 5%, stopping`);
			current = merged;
			break;
		}
		current = merged;
	}

	return current;
}
