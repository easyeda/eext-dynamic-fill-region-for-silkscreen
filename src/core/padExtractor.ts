/**
 * Extract pad shapes from PCB component
 * Uses pad shape data with rotation for accurate polygon
 */

import { createPadPolygon, pointsToSourceArray, sourceArrayToPoints } from '../utils/polygonUtils';

const TAG = '[DynamicFill:PadExtractor]';

/**
 * Get all pad polygons for a component
 * Uses pad shape + rotation to generate accurate rotated polygons
 * @param component The PCB component
 * @returns Array of polygon source arrays representing pads
 */
export async function getPadPolygons(component: IPCB_PrimitiveComponent): Promise<(number | string)[][]> {
	const polygons: (number | string)[][] = [];

	try {
		const pads = await component.getAllPins?.();
		if (!pads || pads.length === 0) {
			console.warn(TAG, 'Component has no pads');
			return polygons;
		}

		console.warn(TAG, `Processing ${pads.length} pads`);

		for (const pad of pads) {
			try {
				const padShape = pad.getState_Pad?.();
				if (!padShape || padShape.length < 2)
					continue;

				const shapeType = padShape[0];

				// POLYGON 类型：直接使用源数组数据
				if (shapeType === 'POLYGON') {
					const polyData = padShape[1] as (number | string)[];
					if (polyData && polyData.length >= 4) {
						const pts = sourceArrayToPoints(polyData);
						if (pts.length >= 3) {
							polygons.push(pointsToSourceArray(pts));
						}
					}
					continue;
				}

				// 使用 pad shape 数据 + 旋转生成多边形
				const x = pad.getState_X?.() ?? 0;
				const y = pad.getState_Y?.() ?? 0;
				const rotation = pad.getState_Rotation?.() ?? 0;
				// getState_Rotation() 返回的是弧度，转为度数
				const rotationDeg = rotation * 180 / Math.PI;
				const points = createPadPolygon(padShape, x, y, rotationDeg);
				if (points && points.length >= 3) {
					polygons.push(pointsToSourceArray(points));
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process pad:', e);
			}
		}

		console.warn(TAG, `Created ${polygons.length} pad polygons`);
	}
	catch (e) {
		console.error(TAG, 'Failed to get pads:', e);
	}

	return polygons;
}
