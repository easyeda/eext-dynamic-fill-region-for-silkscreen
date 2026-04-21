/**
 * Board outline extraction from PCB layer 11
 */

import type { Point } from '../utils/polygonUtils';
import { LAYER_BOARD_OUTLINE } from '../utils/constants';
import { calculateBoundingBoxArea, sourceArrayToPoints } from '../utils/polygonUtils';

const TAG = '[DynamicFill:BoardOutline]';

interface ParsedPolyline {
	points: Point[];
	sourceArray: (number | string)[];
	area: number;
}

/**
 * Parse TPCB_PolygonSourceArray from a polyline primitive
 */
function extractSourceArray(pl: IPCB_PrimitivePolyline): (number | string)[] | null {
	try {
		const complexPolygon = pl.getState_ComplexPolygon?.();
		if (complexPolygon) {
			const src = complexPolygon.getSource?.();
			if (Array.isArray(src)) {
				// Could be TPCB_PolygonSourceArray or Array<TPCB_PolygonSourceArray>
				if (src.length > 0 && Array.isArray(src[0])) {
					return src[0] as (number | string)[];
				}
				return src as (number | string)[];
			}
		}
	}
	catch (e) {
		console.warn(TAG, 'getState_ComplexPolygon failed:', e);
	}

	try {
		const polygon = pl.getState_Polygon?.();
		if (polygon) {
			const src = polygon.getSource?.();
			if (Array.isArray(src)) {
				return src as (number | string)[];
			}
		}
	}
	catch (e) {
		console.warn(TAG, 'getState_Polygon failed:', e);
	}

	return null;
}

/**
 * Get the board outline polygon from PCB layer 11
 * If multiple outlines exist, returns the one with the largest bounding box area
 */
export async function getBoardOutline(): Promise<(number | string)[]> {
	const polylines = await eda.pcb_PrimitivePolyline.getAll(undefined, LAYER_BOARD_OUTLINE);

	if (!polylines || polylines.length === 0) {
		throw new Error('未找到板框（Layer 11），请先绘制板框');
	}

	console.warn(TAG, `Found ${polylines.length} polylines on board outline layer`);

	const parsed: ParsedPolyline[] = [];

	for (const pl of polylines) {
		const sourceArray = extractSourceArray(pl);
		if (!sourceArray || sourceArray.length < 4)
			continue;

		const points = sourceArrayToPoints(sourceArray);
		if (points.length < 3)
			continue;

		const area = calculateBoundingBoxArea(points);
		parsed.push({ points, sourceArray, area });
	}

	if (parsed.length === 0) {
		throw new Error('无法解析板框数据，请检查板框是否正确绘制');
	}

	// Select the polyline with the largest area
	parsed.sort((a, b) => b.area - a.area);
	const largest = parsed[0];

	console.warn(TAG, `Using board outline with area ${largest.area}, ${largest.points.length} points`);

	return largest.sourceArray;
}
