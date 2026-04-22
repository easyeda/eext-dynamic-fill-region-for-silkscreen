/**
 * Polygon utility functions
 */

import { WindingOrder } from './constants';

export interface Point {
	x: number;
	y: number;
}

/**
 * Calculate signed area of a polygon using the shoelace formula
 * Positive area = counter-clockwise winding
 * Negative area = clockwise winding
 */
export function calculateSignedArea(points: Point[]): number {
	if (points.length < 3)
		return 0;

	let area = 0;
	for (let i = 0; i < points.length; i++) {
		const j = (i + 1) % points.length;
		area += points[i].x * points[j].y;
		area -= points[j].x * points[i].y;
	}
	return area / 2;
}

/**
 * Determine winding order of a polygon
 */
export function getWindingOrder(points: Point[]): WindingOrder {
	const area = calculateSignedArea(points);
	if (Math.abs(area) < 1e-6)
		return WindingOrder.UNKNOWN;
	return area > 0 ? WindingOrder.COUNTER_CLOCKWISE : WindingOrder.CLOCKWISE;
}

/**
 * Reverse the winding order of a polygon
 */
export function reverseWindingOrder(points: Point[]): Point[] {
	return [...points].reverse();
}

/**
 * Ensure polygon has clockwise winding order
 */
export function ensureClockwise(points: Point[]): Point[] {
	const order = getWindingOrder(points);
	if (order === WindingOrder.COUNTER_CLOCKWISE) {
		return reverseWindingOrder(points);
	}
	return points;
}

/**
 * Ensure polygon has counter-clockwise winding order
 */
export function ensureCounterClockwise(points: Point[]): Point[] {
	const order = getWindingOrder(points);
	if (order === WindingOrder.CLOCKWISE) {
		return reverseWindingOrder(points);
	}
	return points;
}

/**
 * Calculate the bounding box of a set of points
 */
export function calculateBoundingBox(points: Point[]): { minX: number; minY: number; maxX: number; maxY: number } {
	if (points.length === 0)
		return { minX: 0, minY: 0, maxX: 0, maxY: 0 };

	let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX)
			minX = p.x;
		if (p.x > maxX)
			maxX = p.x;
		if (p.y < minY)
			minY = p.y;
		if (p.y > maxY)
			maxY = p.y;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Test if two AABBs intersect
 */
export function aabbIntersects(
	a: { minX: number; minY: number; maxX: number; maxY: number },
	b: { minX: number; minY: number; maxX: number; maxY: number },
): boolean {
	return a.maxX >= b.minX && b.maxX >= a.minX && a.maxY >= b.minY && b.maxY >= a.minY;
}

/**
 * Calculate area of bounding box of a set of points
 */
export function calculateBoundingBoxArea(points: Point[]): number {
	const bb = calculateBoundingBox(points);
	return (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
}

/**
 * Convert points array to TPCB_PolygonSourceArray format for FILL
 * Format: [x1, y1, 'L', x2, y2, x3, y3, ..., x1, y1]
 * Note: Only first 'L', subsequent coords are continuous, and polygon must be closed
 */
export function pointsToSourceArray(points: Point[]): (number | string)[] {
	if (points.length === 0)
		return [];

	const result: (number | string)[] = [points[0].x, points[0].y, 'L'];
	for (let i = 1; i < points.length; i++) {
		result.push(points[i].x, points[i].y);
	}
	// Close the polygon by repeating the first point
	result.push(points[0].x, points[0].y);
	return result;
}

/**
 * Extract points from TPCB_PolygonSourceArray format
 * Handles: [x1, y1, 'L', x2, y2, x3, y3, ..., x1, y1] (closed polygon)
 * Also handles old format with multiple 'L' tokens
 * Removes duplicate closing point if polygon is closed
 */
export function sourceArrayToPoints(sourceArray: (number | string)[]): Point[] {
	const points: Point[] = [];
	let i = 0;

	while (i < sourceArray.length) {
		const item = sourceArray[i];

		if (typeof item === 'string') {
			if (item === 'L') {
				// After 'L', consume all following number pairs until next string
				i++;
				while (i < sourceArray.length && typeof sourceArray[i] === 'number') {
					if (i + 1 < sourceArray.length && typeof sourceArray[i + 1] === 'number') {
						points.push({ x: sourceArray[i] as number, y: sourceArray[i + 1] as number });
						i += 2;
					}
					else {
						i++;
					}
				}
			}
			else if (item === 'ARC') {
				// ARC angle endX endY - skip arc, just add endpoint
				if (i + 3 < sourceArray.length) {
					points.push({ x: sourceArray[i + 2] as number, y: sourceArray[i + 3] as number });
					i += 4;
				}
				else {
					i++;
				}
			}
			else if (item === 'CARC') {
				// CARC = Center-arc: cx cy radius startAngle endAngle (clockwise)
				// Approximate with line segments
				if (i + 5 < sourceArray.length) {
					const cx = sourceArray[i + 1] as number;
					const cy = sourceArray[i + 2] as number;
					const radius = sourceArray[i + 3] as number;
					const startAngle = sourceArray[i + 4] as number;
					const endAngle = sourceArray[i + 5] as number;
					i += 6;
					if (radius > 0) {
						const segments = Math.max(4, Math.ceil(Math.abs(endAngle - startAngle) / 15));
						for (let s = 0; s <= segments; s++) {
							const t = s / segments;
							const angle = (startAngle + t * (endAngle - startAngle)) * Math.PI / 180;
							points.push({
								x: cx + radius * Math.cos(angle),
								y: cy + radius * Math.sin(angle),
							});
						}
					}
				}
				else {
					i++;
				}
			}
			else if (item === 'C') {
				// C = Cubic Bezier: x1 y1 x2 y2 x y (control1, control2, endpoint)
				// Approximate with line segments
				if (i + 6 < sourceArray.length && points.length > 0) {
					const p0 = points[points.length - 1];
					const cp1x = sourceArray[i + 1] as number;
					const cp1y = sourceArray[i + 2] as number;
					const cp2x = sourceArray[i + 3] as number;
					const cp2y = sourceArray[i + 4] as number;
					const ex = sourceArray[i + 5] as number;
					const ey = sourceArray[i + 6] as number;
					i += 7;
					const segments = 8;
					for (let s = 1; s <= segments; s++) {
						const t = s / segments;
						const mt = 1 - t;
						points.push({
							x: mt * mt * mt * p0.x + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * ex,
							y: mt * mt * mt * p0.y + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * ey,
						});
					}
				}
				else {
					i++;
				}
			}
			else if (item === 'R') {
				// R x y width height rotation cornerRadius
				// (x, y) is the top-left corner of the unrotated rectangle
				if (i + 4 < sourceArray.length) {
					const rx = sourceArray[i + 1] as number;
					const ry = sourceArray[i + 2] as number;
					const rw = sourceArray[i + 3] as number;
					const rh = sourceArray[i + 4] as number;
					i += 5;
					// Parse optional rotation and cornerRadius
					let rotation = 0;
					while (i < sourceArray.length && typeof sourceArray[i] === 'number') {
						if (rotation === 0)
							rotation = sourceArray[i] as number;
						i++;
					}
					// (rx, ry) is the top-left corner of the unrotated rectangle
					const cx = rx + rw / 2;
					const cy = ry - rh / 2;
					const hw = rw / 2;
					const hh = rh / 2;
					const rad = (rotation * Math.PI) / 180;
					const cos = Math.cos(rad);
					const sin = Math.sin(rad);
					const corners = [
						{ x: -hw, y: -hh },
						{ x: hw, y: -hh },
						{ x: hw, y: hh },
						{ x: -hw, y: hh },
					];
					for (const c of corners) {
						points.push({
							x: cx + c.x * cos - c.y * sin,
							y: cy + c.x * sin + c.y * cos,
						});
					}
				}
				else {
					i++;
				}
			}
			else if (item === 'CIRCLE') {
				// CIRCLE cx cy radius
				if (i + 3 < sourceArray.length) {
					const cx = sourceArray[i + 1] as number;
					const cy = sourceArray[i + 2] as number;
					const radius = sourceArray[i + 3] as number;
					i += 4;
					if (radius > 0) {
						const circlePts = createCirclePolygon(cx, cy, radius, 24);
						points.push(...circlePts);
					}
				}
				else {
					i++;
				}
			}
			else {
				i++;
			}
		}
		else if (typeof item === 'number') {
			if (i + 1 < sourceArray.length && typeof sourceArray[i + 1] === 'number') {
				points.push({ x: item, y: sourceArray[i + 1] as number });
				i += 2;
			}
			else {
				i++;
			}
		}
		else {
			i++;
		}
	}

	// Remove duplicate closing point if polygon is closed
	if (points.length > 1) {
		const first = points[0];
		const last = points[points.length - 1];
		if (first.x === last.x && first.y === last.y) {
			points.pop();
		}
	}

	return points;
}

/**
 * Create a rectangle polygon from center, width, height, and rotation
 */
export function createRectanglePolygon(cx: number, cy: number, w: number, h: number, rotation: number): Point[] {
	const hw = w / 2;
	const hh = h / 2;
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);

	const corners = [
		{ x: -hw, y: -hh },
		{ x: hw, y: -hh },
		{ x: hw, y: hh },
		{ x: -hw, y: hh },
	];

	return corners.map(c => ({
		x: cx + c.x * cos - c.y * sin,
		y: cy + c.x * sin + c.y * cos,
	}));
}

/**
 * Create a circle approximation polygon
 */
export function createCirclePolygon(cx: number, cy: number, radius: number, segments = 16): Point[] {
	const points: Point[] = [];
	for (let i = 0; i < segments; i++) {
		const angle = (i / segments) * 2 * Math.PI;
		points.push({
			x: cx + radius * Math.cos(angle),
			y: cy + radius * Math.sin(angle),
		});
	}
	return points;
}

/**
 * Create an ellipse approximation polygon
 */
export function createEllipsePolygon(cx: number, cy: number, rx: number, ry: number, rotation: number, segments = 24): Point[] {
	const points: Point[] = [];
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	for (let i = 0; i < segments; i++) {
		const angle = (i / segments) * 2 * Math.PI;
		const ex = rx * Math.cos(angle);
		const ey = ry * Math.sin(angle);
		points.push({
			x: cx + ex * cos - ey * sin,
			y: cy + ex * sin + ey * cos,
		});
	}
	return points;
}

/**
 * Create an obround (rounded rectangle) polygon approximation
 * When w == h, this degenerates to a circle.
 * w >= h: semicircles on left/right, straight lines top/bottom
 * h > w: semicircles on top/bottom, straight lines left/right
 */
export function createObroundPolygon(cx: number, cy: number, w: number, h: number, rotation: number, segmentsPerHalf = 12): Point[] {
	if (Math.abs(w - h) < 0.001) {
		return createCirclePolygon(cx, cy, w / 2, segmentsPerHalf * 2);
	}

	const points: Point[] = [];
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);

	function addPoint(lx: number, ly: number): void {
		points.push({
			x: cx + lx * cos - ly * sin,
			y: cy + lx * sin + ly * cos,
		});
	}

	if (w >= h) {
		// Semicircles on left and right, straight lines top and bottom
		const r = h / 2;
		const straightLen = w - h; // length of straight section
		const halfStraight = straightLen / 2;

		// Right semicircle (from top to bottom)
		for (let i = 0; i <= segmentsPerHalf; i++) {
			const angle = -Math.PI / 2 + (i / segmentsPerHalf) * Math.PI;
			addPoint(halfStraight + r * Math.cos(angle), r * Math.sin(angle));
		}
		// Left semicircle (from bottom to top)
		for (let i = 0; i <= segmentsPerHalf; i++) {
			const angle = Math.PI / 2 + (i / segmentsPerHalf) * Math.PI;
			addPoint(-halfStraight + r * Math.cos(angle), r * Math.sin(angle));
		}
	}
	else {
		// Semicircles on top and bottom, straight lines left and right
		const r = w / 2;
		const straightLen = h - w;
		const halfStraight = straightLen / 2;

		// Top semicircle (from right to left)
		for (let i = 0; i <= segmentsPerHalf; i++) {
			const angle = 0 + (i / segmentsPerHalf) * Math.PI;
			addPoint(r * Math.cos(angle), halfStraight + r * Math.sin(angle));
		}
		// Bottom semicircle (from left to right)
		for (let i = 0; i <= segmentsPerHalf; i++) {
			const angle = Math.PI + (i / segmentsPerHalf) * Math.PI;
			addPoint(r * Math.cos(angle), -halfStraight + r * Math.sin(angle));
		}
	}

	return points;
}

/**
 * Create a regular polygon (N-gon) with given diameter and number of sides
 */
export function createRegularPolygonPolygon(cx: number, cy: number, diameter: number, sides: number, rotation: number): Point[] {
	const radius = diameter / 2;
	const points: Point[] = [];
	const rad0 = (rotation * Math.PI) / 180;
	const cos0 = Math.cos(rad0);
	const sin0 = Math.sin(rad0);
	const n = Math.max(3, Math.round(sides));
	for (let i = 0; i < n; i++) {
		const angle = (i / n) * 2 * Math.PI;
		const lx = radius * Math.cos(angle);
		const ly = radius * Math.sin(angle);
		points.push({
			x: cx + lx * cos0 - ly * sin0,
			y: cy + lx * sin0 + ly * cos0,
		});
	}
	return points;
}

/**
 * Create a pad polygon based on its shape type
 * @param padShape The pad shape data from getState_Pad()
 * @param x Pad center X
 * @param y Pad center Y
 * @param rotation Pad rotation in degrees
 * @returns Array of Points representing the pad outline, or null if unsupported
 */
export function createPadPolygon(padShape: (number | string)[], x: number, y: number, rotation: number): Point[] | null {
	const shapeType = padShape[0];

	switch (shapeType) {
		case 'ELLIPSE': {
			// [ELLIPSE, width, height]
			const w = padShape[1] as number;
			const h = padShape[2] as number;
			if (w <= 0 || h <= 0)
				return null;
			if (Math.abs(w - h) < 0.001) {
				return createCirclePolygon(x, y, w / 2, 24);
			}
			return createEllipsePolygon(x, y, w / 2, h / 2, rotation, 24);
		}
		case 'OVAL': {
			// [OBLONG, width, height]
			const w = padShape[1] as number;
			const h = padShape[2] as number;
			if (w <= 0 || h <= 0)
				return null;
			return createObroundPolygon(x, y, w, h, rotation);
		}
		case 'RECT': {
			// [RECTANGLE, width, height, round]
			const w = padShape[1] as number;
			const h = padShape[2] as number;
			if (w <= 0 || h <= 0)
				return null;
			return createRectanglePolygon(x, y, w, h, rotation);
		}
		case 'NGON': {
			// [REGULAR_POLYGON, diameter, numberOfSides]
			const diameter = padShape[1] as number;
			const sides = padShape[2] as number;
			if (diameter <= 0 || sides < 3)
				return null;
			return createRegularPolygonPolygon(x, y, diameter, sides, rotation);
		}
		case 'POLYGON': {
			// [POLYLINE_COMPLEX_POLYGON, complexPolygonData] - return null, caller should use source array directly
			return null;
		}
		default:
			return null;
	}
}
