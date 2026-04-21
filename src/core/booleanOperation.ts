/**
 * Boolean operation using complex polygon array format
 *
 * All polygons use L format with screen coordinates.
 * EasyEDA nonzero fill-rule: outer and holes must have OPPOSITE winding.
 *   - Outer: CW
 *   - Holes: CCW
 */

import type { Point } from '../utils/polygonUtils';
import { ensureClockwise, ensureCounterClockwise, getWindingOrder, pointsToSourceArray, sourceArrayToPoints } from '../utils/polygonUtils';

const TAG = '[DynamicFill:BooleanOperation]';

/**
 * Build complex polygon from user-drawn polygon + obstacles
 * Format: [[outer (CW)], [hole1 (CCW)], [hole2 (CCW)], ...]
 * EasyEDA nonzero fill-rule: outer CW, holes CCW (opposite winding).
 * All coordinates in L format, screen coordinates.
 */
export function buildUserPolygonComplex(
	userPoints: Point[],
	obstacles: (number | string)[][],
): (number | string)[][] {
	console.warn(TAG, `Building complex polygon from user polygon (${userPoints.length} pts) + ${obstacles.length} obstacles`);

	// Outer: user polygon, CW
	const outerPoints = ensureClockwise(userPoints);
	const outerSource = pointsToSourceArray(outerPoints);
	const complexPolyArray: (number | string)[][] = [outerSource];

	console.warn(TAG, `Outer: ${outerPoints.length} points, winding=${getWindingOrder(outerPoints)}`);

	// Holes: obstacles, CCW (opposite of outer CW)
	let addedCount = 0;
	for (let i = 0; i < obstacles.length; i++) {
		const obstacle = obstacles[i];
		if (!obstacle || obstacle.length < 4)
			continue;

		try {
			const obstaclePoints = sourceArrayToPoints(obstacle);
			if (obstaclePoints.length < 3)
				continue;

			// Holes must be CCW (opposite of outer CW)
			const holePoints = ensureCounterClockwise(obstaclePoints);
			const holeSource = pointsToSourceArray(holePoints);

			complexPolyArray.push(holeSource);
			addedCount++;
		}
		catch (e) {
			console.warn(TAG, `Failed to add obstacle ${i}:`, e);
		}
	}

	console.warn(TAG, `Complex polygon: 1 outer (CW) + ${addedCount} holes (CCW)`);
	return complexPolyArray;
}

/**
 * Create a fill primitive on the specified layer
 * @param layer Target silkscreen layer (3 or 4)
 * @param complexPolyArray Complex polygon array: [[outer], [hole1], [hole2], ...]
 * @returns Created fill primitive or null if failed
 */
export async function createFillPrimitive(
	layer: number,
	complexPolyArray: (number | string)[][],
): Promise<IPCB_PrimitiveFill | null> {
	try {
		console.warn(TAG, `Creating fill on layer ${layer} with ${complexPolyArray.length} polygons`);

		const complexPolygon = eda.pcb_MathPolygon.createComplexPolygon(complexPolyArray as any);
		if (!complexPolygon) {
			console.error(TAG, 'createComplexPolygon returned undefined');
			return null;
		}

		return await doFillCreate(layer, complexPolygon);
	}
	catch (e) {
		console.error(TAG, 'Failed to create fill:', e);
		return null;
	}
}

/**
 * Create fill with fallback: if direct creation fails, try adding holes one by one
 */
export async function createFillPrimitiveWithFix(
	layer: number,
	complexPolyArray: (number | string)[][],
): Promise<IPCB_PrimitiveFill | null> {
	// Try direct creation first
	const directFill = await createFillPrimitive(layer, complexPolyArray);
	if (directFill)
		return directFill;

	// Fallback: create outer only, then add holes one by one
	if (complexPolyArray.length > 1) {
		try {
			console.warn(TAG, 'Direct creation failed, trying addSource fallback...');
			const outerOnly = eda.pcb_MathPolygon.createComplexPolygon([complexPolyArray[0]] as any);
			if (!outerOnly) {
				console.error(TAG, 'Outer polygon alone failed');
				return null;
			}
			for (let i = 1; i < complexPolyArray.length; i++) {
				try {
					outerOnly.addSource(complexPolyArray[i] as any);
				}
				catch (e) {
					console.warn(TAG, `Failed to add hole ${i}:`, e);
				}
			}
			return await doFillCreate(layer, outerOnly);
		}
		catch (e) {
			console.error(TAG, 'addSource fallback failed:', e);
		}
	}

	return null;
}

async function doFillCreate(layer: number, complexPolygon: any): Promise<IPCB_PrimitiveFill | null> {
	try {
		const fill = await eda.pcb_PrimitiveFill.create(
			layer as any,
			complexPolygon,
			'',
			undefined,
			10,
			false,
		);

		if (!fill) {
			console.error(TAG, 'pcb_PrimitiveFill.create returned undefined');
			return null;
		}

		console.warn(TAG, `Fill created successfully on layer ${layer}`);
		return fill;
	}
	catch (e) {
		console.error(TAG, 'pcb_PrimitiveFill.create threw:', e);
		return null;
	}
}
