/**
 * Polygon offset algorithm for expanding obstacles by gap
 * Implements precise polygon offsetting using vertex normal method
 */

import type { Point } from '../utils/polygonUtils';
import { ensureCounterClockwise, pointsToSourceArray, sourceArrayToPoints } from '../utils/polygonUtils';

const TAG = '[DynamicFill:PolygonOffset]';

/**
 * Detect if polygon is a circle/ellipse approximation and use radial offset
 * Returns the offset points if it's a circle, or null if not
 */
function tryRadialOffset(points: Point[], offset: number): Point[] | null {
	if (points.length < 16)
		return null;

	// Calculate centroid
	let cx = 0; let cy = 0;
	for (const p of points) { cx += p.x; cy += p.y; }
	cx /= points.length;
	cy /= points.length;

	// Calculate distances from centroid
	const radii = points.map(p => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
	const avgRadius = radii.reduce((a, b) => a + b, 0) / radii.length;

	if (avgRadius < 1)
		return null;

	// Check if all radii are close to average (circle detection)
	const maxDeviation = Math.max(...radii.map(r => Math.abs(r - avgRadius)));
	if (maxDeviation / avgRadius > 0.02)
		return null; // >2% deviation, not a circle

	// It's a circle — offset radially
	const newRadius = avgRadius + offset;
	return points.map((p) => {
		const dx = p.x - cx;
		const dy = p.y - cy;
		const dist = Math.sqrt(dx * dx + dy * dy);
		if (dist < 1e-6)
			return { x: cx + offset, y: cy };
		const scale = newRadius / dist;
		return { x: cx + dx * scale, y: cy + dy * scale };
	});
}

/**
 * Calculate the perpendicular offset vector for a vertex
 * @param prev Previous point
 * @param curr Current point
 * @param next Next point
 * @param offset Offset distance (positive = outward)
 * @param negateBisector Negate the bisector direction (needed for CCW polygons to expand outward)
 * @returns Offset point
 */
function calculateVertexOffset(prev: Point, curr: Point, next: Point, offset: number, negateBisector: boolean): Point {
	// Calculate edge vectors
	const v1x = curr.x - prev.x;
	const v1y = curr.y - prev.y;
	const v2x = next.x - curr.x;
	const v2y = next.y - curr.y;

	// Normalize edge vectors
	const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
	const len2 = Math.sqrt(v2x * v2x + v2y * v2y);

	if (len1 < 1e-6 || len2 < 1e-6) {
		return { x: curr.x, y: curr.y };
	}

	const n1x = v1x / len1;
	const n1y = v1y / len1;
	const n2x = v2x / len2;
	const n2y = v2y / len2;

	// Perpendicular normals (outward for CCW polygon, inward for CW polygon)
	const p1x = n1y;
	const p1y = -n1x;
	const p2x = n2y;
	const p2y = -n2x;

	// Bisector points inward for CCW polygon (negate for outward offset, or use as-is for capsules)
	const bx = p1x + p2x;
	const by = p1y + p2y;
	const blen = Math.sqrt(bx * bx + by * by);

	if (blen < 1e-6) {
		const nx = negateBisector ? -p1x : p1x;
		const ny = negateBisector ? -p1y : p1y;
		return { x: curr.x + nx * offset, y: curr.y + ny * offset };
	}

	let bnx = bx / blen;
	let bny = by / blen;

	if (negateBisector) {
		bnx = -bnx;
		bny = -bny;
	}

	// Angle between edges
	const dot = n1x * n2x + n1y * n2y;
	const sinHalfAngle = Math.sqrt(Math.max(0, (1 - dot) / 2));
	const cosHalfAngle = Math.sqrt(Math.max(0, (1 + dot) / 2));

	if (sinHalfAngle > 0.5) {
		// Sharp corner: offset along bisector, scale by 1/sinHalfAngle, limit
		const offsetDist = offset / sinHalfAngle;
		const limited = Math.min(Math.abs(offsetDist), offset * 2) * Math.sign(offsetDist);
		return { x: curr.x + bnx * limited, y: curr.y + bny * limited };
	}

	// Gentle curve (arc-like): use arc offset formula
	// For a circular arc with radius R, offset d gives new radius R+d
	// The vertex moves along the bisector by distance d / cos(halfAngle)
	if (cosHalfAngle > 0.01) {
		const arcOffset = offset / cosHalfAngle;
		return { x: curr.x + bnx * arcOffset, y: curr.y + bny * arcOffset };
	}

	return { x: curr.x + bnx * offset, y: curr.y + bny * offset };
}

/**
 * Offset a polygon outward by a given distance
 * For rotated polygons (text, components), the correct approach is:
 * 1. Rotate points back to 0 degrees around center
 * 2. Offset the unrotated polygon
 * 3. Rotate the offset polygon back to original angle
 * This ensures the offset is always perpendicular to the edges, not distorted by rotation.
 * @param points Polygon points (should be CCW for outward expansion)
 * @param offset Offset distance in mils (positive = expand outward)
 * @param rotation Rotation angle in degrees (0 = no rotation, use direct offset; non-zero = apply rotate-offset-rotate-back)
 * @param negateBisector Negate the bisector (true for CCW polygons like rectangles to expand outward; false for CCW capsules like line-capsules)
 * @returns Offset polygon points
 */
export function offsetPolygonPoints(points: Point[], offset: number, rotation: number = 0, negateBisector: boolean = false): Point[] {
	if (points.length < 3)
		return points;
	if (Math.abs(offset) < 1e-6)
		return points;

	// For rotated polygons, use rotate-offset-rotate-back approach
	if (Math.abs(rotation) > 0.01) {
		const rad = rotation * Math.PI / 180;
		const cosR = Math.cos(rad);
		const sinR = Math.sin(rad);

		// Calculate center (centroid)
		let cx = 0; let cy = 0;
		for (const p of points) { cx += p.x; cy += p.y; }
		cx /= points.length;
		cy /= points.length;

		// Step 1: Rotate points back to 0 degrees around center
		const unrotated = points.map(p => ({
			x: (p.x - cx) * cosR + (p.y - cy) * sinR + cx,
			y: -(p.x - cx) * sinR + (p.y - cy) * cosR + cy
		}));

		// Step 2: Offset the unrotated polygon
		const offsetPoints = offsetPolygonPoints(unrotated, offset, 0, negateBisector);

		// Step 3: Rotate the offset polygon back to original angle
		return offsetPoints.map(p => ({
			x: (p.x - cx) * cosR - (p.y - cy) * sinR + cx,
			y: (p.x - cx) * sinR + (p.y - cy) * cosR + cy
		}));
	}

	// For non-rotated polygons, use direct offset
	const offsetPoints: Point[] = [];
	const n = points.length;

	for (let i = 0; i < n; i++) {
		const prev = points[(i - 1 + n) % n];
		const curr = points[i];
		const next = points[(i + 1) % n];

		const offsetPoint = calculateVertexOffset(prev, curr, next, offset, negateBisector);
		offsetPoints.push(offsetPoint);
	}

	return offsetPoints;
}

/**
 * Offset a polygon source array by a given distance
 * @param sourceArray Polygon in TPCB_PolygonSourceArray format
 * @param offset Offset distance in mils (positive = expand outward)
 * @param negateBisector Negate the bisector (true for CCW polygons, false for CCW capsules)
 * @returns Offset polygon source array
 */
export function offsetPolygon(sourceArray: (number | string)[], offset: number, negateBisector: boolean = false): (number | string)[] {
	if (Math.abs(offset) < 1e-6)
		return sourceArray;

	try {
		const points = sourceArrayToPoints(sourceArray);
		if (points.length < 3)
			return sourceArray;

		const offsetPoints = offsetPolygonPoints(points, offset, 0, negateBisector);
		return pointsToSourceArray(offsetPoints);
	}
	catch (e) {
		console.error(TAG, 'Failed to offset polygon:', e);
		return sourceArray;
	}
}

/**
 * Offset multiple polygons by a given distance
 * @param sourceArrays Array of polygon source arrays
 * @param offset Offset distance in mils
 * @param negateBisector Negate the bisector (true for CCW polygons, false for CCW capsules)
 */
export function offsetPolygons(sourceArrays: (number | string)[][], offset: number, negateBisector: boolean = false): (number | string)[][] {
	return sourceArrays.map(arr => offsetPolygon(arr, offset, negateBisector));
}

export interface ObstacleForOffset {
	points: Point[];
	rotation: number;
	negateBisector: boolean;
	extraGap: number;
}

export function offsetObstacles(obstacles: ObstacleForOffset[]): Point[][] {
	return obstacles.map((obs) => {
		const ccwPts = ensureCounterClockwise(obs.points);
		const rotation = Math.abs(obs.rotation) > 0.01 ? obs.rotation : 0;
		return offsetPolygonPoints(ccwPts, obs.extraGap, rotation, obs.negateBisector);
	});
}
