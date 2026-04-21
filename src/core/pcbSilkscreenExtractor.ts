/**
 * Extract silkscreen primitives directly from PCB document
 */

import type { Point } from '../utils/polygonUtils';
import { createCirclePolygon, createRectanglePolygon, pointsToSourceArray } from '../utils/polygonUtils';

const TAG = '[DynamicFill:PCBSilkscreen]';

/**
 * Get all silkscreen primitives from PCB document on specified layer
 */
export async function getPCBSilkscreenShapes(targetLayer: number): Promise<(number | string)[][]> {
	const shapes: (number | string)[][] = [];

	try {
		// Get all lines on silkscreen layer
		const lines = await eda.pcb_PrimitiveLine.getAll(undefined, targetLayer);
		if (lines) {
			for (const line of lines) {
				const x1 = line.getState_StartX();
				const y1 = line.getState_StartY();
				const x2 = line.getState_EndX();
				const y2 = line.getState_EndY();
				const width = line.getState_LineWidth() || 0;

				if (width > 0) {
					// Create rectangle for line with width
					const dx = x2 - x1;
					const dy = y2 - y1;
					const len = Math.sqrt(dx * dx + dy * dy);
					if (len < 1e-6)
						continue;

					const nx = -dy / len;
					const ny = dx / len;
					const hw = width / 2;

					const points: Point[] = [
						{ x: x1 + nx * hw, y: y1 + ny * hw },
						{ x: x2 + nx * hw, y: y2 + ny * hw },
						{ x: x2 - nx * hw, y: y2 - ny * hw },
						{ x: x1 - nx * hw, y: y1 - ny * hw },
					];
					shapes.push(pointsToSourceArray(points));
				}
				else {
					shapes.push([x1, y1, 'L', x2, y2]);
				}
			}
		}

		// Get all arcs on silkscreen layer
		const arcs = await eda.pcb_PrimitiveArc.getAll(undefined, targetLayer);
		if (arcs) {
			for (const arc of arcs) {
				const x = arc.getState_X();
				const y = arc.getState_Y();
				const radius = arc.getState_Radius();
				const startAngle = arc.getState_StartAngle() * Math.PI / 180;
				const endAngle = arc.getState_EndAngle() * Math.PI / 180;

				// Approximate arc with line segments
				const segments = Math.max(8, Math.ceil(Math.abs(endAngle - startAngle) / (Math.PI / 8)));
				const points: Point[] = [];

				for (let i = 0; i <= segments; i++) {
					const angle = startAngle + (endAngle - startAngle) * (i / segments);
					points.push({
						x: x + radius * Math.cos(angle),
						y: y + radius * Math.sin(angle),
					});
				}

				if (points.length >= 2) {
					shapes.push(pointsToSourceArray(points));
				}
			}
		}

		// Get all circles on silkscreen layer
		const circles = await eda.pcb_PrimitiveCircle.getAll(undefined, targetLayer);
		if (circles) {
			for (const circle of circles) {
				const x = circle.getState_X();
				const y = circle.getState_Y();
				const radius = circle.getState_Radius();

				const points = createCirclePolygon(x, y, radius, 16);
				shapes.push(pointsToSourceArray(points));
			}
		}

		// Get all texts on silkscreen layer
		const texts = await eda.pcb_PrimitiveText.getAll(undefined, targetLayer);
		if (texts) {
			for (const text of texts) {
				const x = text.getState_X();
				const y = text.getState_Y();
				const fontSize = text.getState_FontSize() || 50;
				const textValue = text.getState_Text() || '';
				const width = textValue.length * fontSize * 0.6;
				const height = fontSize;

				const rect = createRectanglePolygon(x - width / 2, y - height / 2, width, height);
				shapes.push(pointsToSourceArray(rect));
			}
		}

		// Get all rectangles on silkscreen layer
		const rects = await eda.pcb_PrimitiveRectangle.getAll(undefined, targetLayer);
		if (rects) {
			for (const rect of rects) {
				const x = rect.getState_X();
				const y = rect.getState_Y();
				const width = rect.getState_Width();
				const height = rect.getState_Height();

				const points = createRectanglePolygon(x, y, width, height);
				shapes.push(pointsToSourceArray(points));
			}
		}

		console.warn(TAG, `Extracted ${shapes.length} silkscreen shapes from PCB document on layer ${targetLayer}`);
	}
	catch (e) {
		console.error(TAG, 'Failed to extract PCB silkscreen shapes:', e);
	}

	return shapes;
}
