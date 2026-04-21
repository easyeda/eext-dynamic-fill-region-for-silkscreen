/**
 * Extract silkscreen layer shapes from parsed footprint primitives
 */

import type { Point } from '../utils/polygonUtils';
import type { FootprintPrimitive } from './footprintParser';
import { LAYER_SILKSCREEN_IN_FOOTPRINT } from '../utils/constants';
import { createCirclePolygon, createRectanglePolygon, pointsToSourceArray } from '../utils/polygonUtils';

const TAG = '[DynamicFill:SilkscreenExtractor]';

/**
 * Convert a LINE primitive to polygon source array
 */
function lineToPolygon(data: any): (number | string)[] | null {
	const x1 = Number(data.x1 ?? data.startX ?? 0);
	const y1 = Number(data.y1 ?? data.startY ?? 0);
	const x2 = Number(data.x2 ?? data.endX ?? 0);
	const y2 = Number(data.y2 ?? data.endY ?? 0);
	const strokeWidth = Number(data.strokeWidth ?? data.lineWidth ?? 0);

	if (strokeWidth <= 0) {
		// Zero-width line, treat as thin line
		return [x1, y1, 'L', x2, y2];
	}

	// Create a rectangle representing the line with width
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1e-6)
		return null;

	const nx = -dy / len;
	const ny = dx / len;
	const hw = strokeWidth / 2;

	const points: Point[] = [
		{ x: x1 + nx * hw, y: y1 + ny * hw },
		{ x: x2 + nx * hw, y: y2 + ny * hw },
		{ x: x2 - nx * hw, y: y2 - ny * hw },
		{ x: x1 - nx * hw, y: y1 - ny * hw },
	];

	return pointsToSourceArray(points);
}

/**
 * Convert an ARC primitive to polygon source array (approximate with line segments)
 */
function arcToPolygon(data: any): (number | string)[] | null {
	const centerX = Number(data.centerX ?? data.x ?? 0);
	const centerY = Number(data.centerY ?? data.y ?? 0);
	const radius = Number(data.radius ?? 0);
	const startAngle = Number(data.startAngle ?? 0);
	const endAngle = Number(data.endAngle ?? 0);
	const strokeWidth = Number(data.strokeWidth ?? data.lineWidth ?? 0);

	if (radius <= 0)
		return null;

	// Approximate arc with line segments
	const segments = Math.max(8, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 8)));
	const points: Point[] = [];

	for (let i = 0; i <= segments; i++) {
		const angle = startAngle + (endAngle - startAngle) * (i / segments);
		const r = radius + strokeWidth / 2;
		points.push({
			x: centerX + r * Math.cos(angle),
			y: centerY + r * Math.sin(angle),
		});
	}

	return pointsToSourceArray(points);
}

/**
 * Convert a POLY primitive to polygon source array
 */
function polyToPolygon(data: any): (number | string)[] | null {
	const path = data.path ?? data.points ?? [];
	if (!Array.isArray(path) || path.length < 4)
		return null;

	// The path is already in source array format
	return path as (number | string)[];
}

/**
 * Convert a FILL primitive to polygon source array
 */
function fillToPolygon(data: any): (number | string)[] | null {
	const points = data.points ?? [];
	if (!Array.isArray(points) || points.length < 3)
		return null;

	const polygonPoints: Point[] = points.map((p: any) => ({
		x: Number(p.x ?? 0),
		y: Number(p.y ?? 0),
	}));

	return pointsToSourceArray(polygonPoints);
}

/**
 * Convert a STRING/TEXT primitive to bounding box polygon
 */
function textToPolygon(data: any): (number | string)[] | null {
	const x = Number(data.x ?? data.positionX ?? 0);
	const y = Number(data.y ?? data.positionY ?? 0);
	const fontSize = Number(data.fontSize ?? 10);
	const text = String(data.text ?? '');
	const angle = Number(data.angle ?? data.rotation ?? 0);

	if (text.length === 0)
		return null;

	// Approximate text bounding box
	const width = fontSize * text.length * 0.6;
	const height = fontSize;

	const points = createRectanglePolygon(x + width / 2, y + height / 2, width, height, angle);
	return pointsToSourceArray(points);
}

/**
 * Convert a CIRCLE primitive to polygon
 */
function circleToPolygon(data: any): (number | string)[] | null {
	const x = Number(data.x ?? data.centerX ?? 0);
	const y = Number(data.y ?? data.centerY ?? 0);
	const radius = Number(data.radius ?? data.r ?? 0);

	if (radius <= 0)
		return null;

	const points = createCirclePolygon(x, y, radius, 16);
	return pointsToSourceArray(points);
}

/**
 * Extract silkscreen layer shapes from footprint primitives
 * Returns array of polygon source arrays
 */
export function extractSilkscreenShapes(primitives: FootprintPrimitive[]): (number | string)[][] {
	const shapes: (number | string)[][] = [];

	for (const prim of primitives) {
		// Filter for silkscreen layer (layer 3 in footprint)
		if (prim.layerId !== LAYER_SILKSCREEN_IN_FOOTPRINT)
			continue;

		let polygon: (number | string)[] | null = null;

		switch (prim.type.toUpperCase()) {
			case 'LINE':
				polygon = lineToPolygon(prim.data);
				break;
			case 'ARC':
				polygon = arcToPolygon(prim.data);
				break;
			case 'POLY':
			case 'POLYLINE':
				polygon = polyToPolygon(prim.data);
				break;
			case 'FILL':
			case 'SOLIDREGION':
				polygon = fillToPolygon(prim.data);
				break;
			case 'STRING':
			case 'TEXT':
				polygon = textToPolygon(prim.data);
				break;
			case 'CIRCLE':
				polygon = circleToPolygon(prim.data);
				break;
			default:
				console.warn(TAG, `Unknown primitive type: ${prim.type}`);
		}

		if (polygon && polygon.length >= 4) {
			shapes.push(polygon);
		}
	}

	console.warn(TAG, `Extracted ${shapes.length} silkscreen shapes`);
	return shapes;
}
