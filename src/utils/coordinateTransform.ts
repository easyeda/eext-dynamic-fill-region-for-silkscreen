/**
 * Coordinate transformation utilities
 */

import type { Point } from './polygonUtils';

/**
 * Transform a point from footprint local coordinates to PCB world coordinates
 * @param fpX Footprint local X coordinate
 * @param fpY Footprint local Y coordinate
 * @param compX Component X position on PCB
 * @param compY Component Y position on PCB
 * @param rotation Component rotation in degrees
 * @param mirror Whether component is mirrored (bottom side)
 */
export function transformPoint(
	fpX: number,
	fpY: number,
	compX: number,
	compY: number,
	rotation: number,
	mirror: boolean = false,
): Point {
	let x = fpX;
	const y = fpY;

	// Apply mirror transformation if needed
	if (mirror) {
		x = -x;
	}

	// Apply rotation
	const rad = (rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);

	const rotatedX = x * cos - y * sin;
	const rotatedY = x * sin + y * cos;

	// Translate to component position
	return {
		x: compX + rotatedX,
		y: compY + rotatedY,
	};
}

/**
 * Transform an array of points from footprint to world coordinates
 */
export function transformPoints(
	points: Point[],
	compX: number,
	compY: number,
	rotation: number,
	mirror: boolean = false,
): Point[] {
	return points.map(p => transformPoint(p.x, p.y, compX, compY, rotation, mirror));
}

/**
 * Transform a polygon source array from footprint to world coordinates
 */
export function transformSourceArray(
	sourceArray: (number | string)[],
	compX: number,
	compY: number,
	rotation: number,
	mirror: boolean = false,
): (number | string)[] {
	const result: (number | string)[] = [];
	let i = 0;

	while (i < sourceArray.length) {
		const item = sourceArray[i];

		if (typeof item === 'number') {
			// This is a coordinate pair
			if (i + 1 < sourceArray.length && typeof sourceArray[i + 1] === 'number') {
				const transformed = transformPoint(item, sourceArray[i + 1] as number, compX, compY, rotation, mirror);
				result.push(transformed.x, transformed.y);
				i += 2;
			}
			else {
				result.push(item);
				i++;
			}
		}
		else {
			// This is a command string
			result.push(item);
			i++;
		}
	}

	return result;
}
