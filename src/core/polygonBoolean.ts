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
export function mergeOverlappingObstacles(
	obstacles: Point[][],
): Point[][] {
	if (obstacles.length <= 1)
		return obstacles;

	const n = obstacles.length;

	// Pre-compute bounding boxes
	const bboxes = obstacles.map(pts => calculateBoundingBox(pts));

	// Union-find
	const parent = Array.from({ length: n }, (_, i) => i);

	function find(x: number): number {
		while (parent[x] !== x) {
			parent[x] = parent[parent[x]];
			x = parent[x];
		}
		return x;
	}

	function unite(a: number, b: number): void {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb)
			parent[ra] = rb;
	}

	// Pairwise intersection detection — AABB check for grouping
	// Note: AABB overlap is conservative (may group non-overlapping circles/capsules),
	// but the subsequent chain union handles this correctly — union of non-overlapping
	// polygons simply returns them as separate polygons in the result.
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (aabbIntersects(bboxes[i], bboxes[j])) {
				unite(i, j);
			}
		}
	}

	// Group by root
	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		if (!groups.has(r))
			groups.set(r, []);
		groups.get(r)!.push(i);
	}

	// Chain union for each group
	const merged: Point[][] = [];
	for (const indices of groups.values()) {
		if (indices.length === 1) {
			// No overlap — keep original
			merged.push(obstacles[indices[0]]);
			continue;
		}

		try {
			const geoms: Geom[] = indices.map(idx => [pointsToRing(obstacles[idx])]);
			const current = union(geoms[0], ...geoms.slice(1));

			// Extract result polygons
			for (const poly of current) {
				if (poly.length > 0) {
					const outerRing = poly[0];
					if (outerRing.length >= 4) { // at least 3 points + closing point
						merged.push(ringToPoints(outerRing));
					}
				}
			}
			console.warn(TAG, `Merged ${indices.length} overlapping obstacles into ${current.length} polygon(s)`);
		}
		catch (e) {
			console.warn(TAG, 'Union failed for group, keeping separate:', e);
			for (const idx of indices) {
				merged.push(obstacles[idx]);
			}
		}
	}

	return merged;
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
 * Async incremental boolean difference — processes holes in batches to avoid blocking the main thread.
 * Yields to the event loop between batches via setTimeout(0).
 */
export async function subtractHolesFromRegionIncremental(
	region: Point[],
	holes: Point[][],
	onProgress?: (done: number, total: number) => void,
	batchSize: number = 20,
): Promise<{ outer: Point[]; holes: Point[][] }[]> {
	if (holes.length === 0)
		return [{ outer: region, holes: [] }];

	const regionRing = pointsToRing(region);
	let resultGeom: Geom = [regionRing];

	for (let i = 0; i < holes.length; i += batchSize) {
		const batch = holes.slice(i, i + batchSize);
		const holePolys: Geom[] = batch.map(hole => [pointsToRing(hole)]);
		try {
			resultGeom = difference(resultGeom, ...holePolys);
		}
		catch (e) {
			for (const holePoly of holePolys) {
				try { resultGeom = difference(resultGeom, holePoly); }
				catch (_) {}
			}
		}
		onProgress?.(Math.min(i + batchSize, holes.length), holes.length);
		await new Promise<void>(r => setTimeout(r, 0));
	}

	console.warn(TAG, `Incremental difference returned ${resultGeom.length} polygon(s)`);

	const results: { outer: Point[]; holes: Point[][] }[] = [];
	for (const poly of resultGeom) {
		if (poly.length === 0)
			continue;
		const outerRing = poly[0];
		if (outerRing.length < 4)
			continue;
		const outer = ringToPoints(outerRing);
		const innerHoles: Point[][] = [];
		for (let i = 1; i < poly.length; i++) {
			if (poly[i].length >= 4)
				innerHoles.push(ringToPoints(poly[i]));
		}
		results.push({ outer, holes: innerHoles });
	}
	return results;
}
