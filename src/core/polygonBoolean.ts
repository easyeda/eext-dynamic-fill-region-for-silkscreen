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
 * Calculate area of a closed ring using shoelace formula
 */
function ringArea(ring: [number, number][]): number {
	let area = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		area += ring[i][0] * ring[i + 1][1];
		area -= ring[i + 1][0] * ring[i][1];
	}
	return Math.abs(area) / 2;
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

	// Pairwise intersection detection — pure AABB check (fast, no polyclip call)
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
			// Chain union all polygons in this group
			let current: Geom = [pointsToRing(obstacles[indices[0]])];
			for (let k = 1; k < indices.length; k++) {
				const next: Geom = [pointsToRing(obstacles[indices[k]])];
				current = union(current, next);
			}

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

/**
 * Clip obstacles to only keep the portions inside the user-drawn region.
 * Obstacles completely outside the region are discarded.
 * Obstacles partially inside are clipped to the intersection.
 */
export function clipObstaclesToRegion(
	obstacles: Point[][],
	region: Point[],
): Point[][] {
	if (obstacles.length === 0)
		return obstacles;

	const regionGeom: Geom = [pointsToRing(region)];
	const regionBB = calculateBoundingBox(region);
	const result: Point[][] = [];

	for (const obs of obstacles) {
		try {
			// AABB quick reject
			const obsBB = calculateBoundingBox(obs);
			if (obsBB.maxX < regionBB.minX || regionBB.maxX < obsBB.minX)
				continue;
			if (obsBB.maxY < regionBB.minY || regionBB.maxY < obsBB.minY)
				continue;

			const obsGeom: Geom = [pointsToRing(obs)];
			const clipped = intersection(regionGeom, obsGeom);

			for (const poly of clipped) {
				if (poly.length > 0) {
					const outerRing = poly[0];
					if (outerRing.length >= 4) {
						result.push(ringToPoints(outerRing));
					}
				}
			}
		}
		catch (e) {
			// If intersection fails, keep the obstacle (conservative)
			result.push(obs);
		}
	}

	return result;
}

/**
 * Boolean difference: user region minus merged holes.
 * Uses polyclip-ts difference to cleanly subtract holes from the region.
 * Returns an array of result polygons, each as Point[].
 * Each result polygon has an outer ring and zero or more inner rings (holes).
 */
export function subtractHolesFromRegion(
	region: Point[],
	holes: Point[][],
): { outer: Point[]; holes: Point[][] }[] {
	const regionRing = pointsToRing(region);

	if (holes.length === 0) {
		return [{ outer: region, holes: [] }];
	}

	// Build region as a Poly (one outer ring)
	const regionPoly: Geom = [regionRing];

	// Build each hole as a separate Poly, pass them all to difference
	const holePolys: Geom[] = holes.map(hole => [pointsToRing(hole)]);

	let resultGeom: Geom;
	try {
		resultGeom = difference(regionPoly, ...holePolys);
	}
	catch (e) {
		console.warn(TAG, 'Difference with all holes failed, trying incremental approach:', e);
		// Fallback: add holes one by one, skip those that cause failure
		resultGeom = regionPoly;
		let skipped = 0;
		for (const holePoly of holePolys) {
			try {
				resultGeom = difference(resultGeom, holePoly);
			}
			catch (e2) {
				skipped++;
				console.warn(TAG, 'Skipping hole due to difference failure:', e2);
			}
		}
		if (skipped > 0) {
			console.warn(TAG, `Skipped ${skipped} hole(s) that caused difference failure`);
		}
		// If all holes were skipped, return original region
		if (resultGeom === regionPoly && skipped === holePolys.length) {
			return [{ outer: region, holes: [] }];
		}
	}

	console.warn(TAG, `Difference returned ${resultGeom.length} polygon(s)`);

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
			const innerRing = poly[i];
			if (innerRing.length >= 4) {
				innerHoles.push(ringToPoints(innerRing));
			}
		}
		console.warn(TAG, `Result poly: outer=${outer.length} pts, holes=${innerHoles.length}`);
		results.push({ outer, holes: innerHoles });
	}

	return results;
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
