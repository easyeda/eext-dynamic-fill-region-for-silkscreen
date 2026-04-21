/**
 * Extract designator attribute bounding box from PCB component
 * Uses attr position + font size + rotation to build rotated rectangle
 */

import { createRectanglePolygon, pointsToSourceArray } from '../utils/polygonUtils';

const TAG = '[DynamicFill:DesignatorExtractor]';

/**
 * Get designator bounding box for a component as a rotated rectangle
 * @param component The PCB component
 * @param targetLayer The target silkscreen layer (3 or 4)
 * @returns Polygon source array representing the designator bbox, or null if not found
 */
export async function getDesignatorBoundingBox(
	component: IPCB_PrimitiveComponent,
	targetLayer: number,
): Promise<(number | string)[] | null> {
	try {
		const primitiveId = component.getState_PrimitiveId();
		if (!primitiveId) {
			console.warn(TAG, 'Component has no primitive ID');
			return null;
		}

		// Get attributes for this specific component
		const attributes = await eda.pcb_PrimitiveAttribute.getAll(primitiveId as any);
		if (!attributes || attributes.length === 0) {
			return null;
		}

		for (const attr of attributes) {
			const layer = attr.getState_Layer();
			const key = attr.getState_Key();

			if (layer !== targetLayer)
				continue;
			if (key !== 'Designator')
				continue;

			const value = attr.getState_Value() || '';
			if (value.length === 0)
				continue;

			const attrId = attr.getState_PrimitiveId();
			if (!attrId)
				continue;

			const rotation = attr.getState_Rotation?.() || 0;

			// Use actual BBox from EDA
			const bbox = await eda.pcb_Primitive.getPrimitivesBBox([attrId as any]);
			if (!bbox)
				continue;

			const bboxCx = (bbox.minX + bbox.maxX) / 2;
			const bboxCy = (bbox.minY + bbox.maxY) / 2;
			const bboxW = bbox.maxX - bbox.minX;
			const bboxH = bbox.maxY - bbox.minY;
			if (bboxW <= 0 || bboxH <= 0)
				continue;

			if (Math.abs(rotation) < 0.01) {
				// No rotation — use BBox directly
				const points = createRectanglePolygon(bboxCx, bboxCy, bboxW, bboxH, 0);
				console.warn(TAG, `  Designator "${value}" bbox: ${bboxW.toFixed(0)}x${bboxH.toFixed(0)} at (${bboxCx.toFixed(1)}, ${bboxCy.toFixed(1)})`);
				return pointsToSourceArray(points);
			}

			// Rotated — compute original unrotated size from rotated BBox
			// BBox is axis-aligned of rotated rect: bw = |w*cos|+|h*sin|, bh = |w*sin|+|h*cos|
			const rad = rotation * Math.PI / 180;
			const cosR = Math.abs(Math.cos(rad));
			const sinR = Math.abs(Math.sin(rad));
			// Solve: bw = w*cos + h*sin, bh = w*sin + h*cos
			const denom = cosR * cosR - sinR * sinR;
			if (Math.abs(denom) < 0.01) {
				// ~45° rotation, approximate as square
				const size = Math.max(bboxW, bboxH) / (cosR + sinR);
				const points = createRectanglePolygon(bboxCx, bboxCy, size, size, rotation);
				return pointsToSourceArray(points);
			}
			const w = (bboxW * cosR - bboxH * sinR) / denom;
			const h = (bboxH * cosR - bboxW * sinR) / denom;
			if (w > 0 && h > 0) {
				const points = createRectanglePolygon(bboxCx, bboxCy, w, h, rotation);
				console.warn(TAG, `  Designator "${value}" rotated: ${w.toFixed(0)}x${h.toFixed(0)} rot=${rotation}° at (${bboxCx.toFixed(1)}, ${bboxCy.toFixed(1)})`);
				return pointsToSourceArray(points);
			}

			// Fallback: use axis-aligned BBox
			const points = createRectanglePolygon(bboxCx, bboxCy, bboxW, bboxH, 0);
			return pointsToSourceArray(points);
		}

		return null;
	}
	catch (e) {
		console.error(TAG, 'Failed to get designator bbox:', e);
		return null;
	}
}
