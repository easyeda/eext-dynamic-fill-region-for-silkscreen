/**
 * Component data fetcher - gets all components and their footprint data
 */

import type { Point } from '../utils/polygonUtils';
import { createCirclePolygon, createPadPolygon, createRectanglePolygon, pointsToSourceArray, sourceArrayToPoints } from '../utils/polygonUtils';
import { getDesignatorBoundingBox } from './designatorExtractor';
import { offsetPolygonPoints } from './polygonOffset';

const TAG = '[DynamicFill:ComponentData]';

const CAP_SEGMENTS = 8;

function createLineCapsule(x1: number, y1: number, x2: number, y2: number, lineWidth: number): Point[] | null {
	const r = lineWidth / 2;
	if (r < 1) return null;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.sqrt(dx * dx + dy * dy);
	if (len < 1) return null;
	const ux = dx / len;
	const uy = dy / len;
	const nx = -uy;
	const ny = ux;
	const pts: Point[] = [];
	for (let j = 0; j <= CAP_SEGMENTS; j++) {
		const angle = Math.PI / 2 + (j / CAP_SEGMENTS) * Math.PI;
		pts.push({
			x: x1 + r * (Math.cos(angle) * ux + Math.sin(angle) * nx),
			y: y1 + r * (Math.cos(angle) * uy + Math.sin(angle) * ny),
		});
	}
	for (let j = 0; j <= CAP_SEGMENTS; j++) {
		const angle = -Math.PI / 2 + (j / CAP_SEGMENTS) * Math.PI;
		pts.push({
			x: x2 + r * (Math.cos(angle) * ux + Math.sin(angle) * nx),
			y: y2 + r * (Math.cos(angle) * uy + Math.sin(angle) * ny),
		});
	}
	return pts.length >= 3 ? pts : null;
}

function createArcCapsule(x1: number, y1: number, x2: number, y2: number, arcAngleDeg: number, lineWidth: number): Point[] | null {
	const r = lineWidth / 2;
	if (r < 1 || Math.abs(arcAngleDeg) < 0.01) return null;

	const arcAngle = arcAngleDeg * Math.PI / 180;
	const mx = (x1 + x2) / 2;
	const my = (y1 + y2) / 2;
	const dx = x2 - x1;
	const dy = y2 - y1;
	const chordLen = Math.sqrt(dx * dx + dy * dy);
	if (chordLen < 1) return null;

	const halfAngle = arcAngle / 2;
	const sinHalf = Math.sin(halfAngle);
	if (Math.abs(sinHalf) < 1e-6) return createLineCapsule(x1, y1, x2, y2, lineWidth);

	const radius = chordLen / (2 * Math.abs(sinHalf));
	const d = radius * Math.cos(halfAngle);

	const px = -dy / chordLen;
	const py = dx / chordLen;
	const sign = arcAngleDeg > 0 ? 1 : -1;
	const cx = mx + px * d * sign;
	const cy = my + py * d * sign;

	const startAngle = Math.atan2(y1 - cy, x1 - cx);
	const endAngle = Math.atan2(y2 - cy, x2 - cx);

	let sweep = endAngle - startAngle;
	if (arcAngleDeg > 0) {
		while (sweep < 0) sweep += 2 * Math.PI;
	}
	else {
		while (sweep > 0) sweep -= 2 * Math.PI;
	}

	const arcSegs = Math.max(16, Math.ceil(Math.abs(arcAngleDeg) / 5));
	const capSegs = 12;
	const outerPts: Point[] = [];
	const innerPts: Point[] = [];
	for (let i = 0; i <= arcSegs; i++) {
		const t = i / arcSegs;
		const a = startAngle + t * sweep;
		const cos = Math.cos(a);
		const sin = Math.sin(a);
		outerPts.push({ x: cx + (radius + r) * cos, y: cy + (radius + r) * sin });
		innerPts.push({ x: cx + (radius - r) * cos, y: cy + (radius - r) * sin });
	}

	// Build: outer → end cap → inner reversed → start cap
	const pts: Point[] = [...outerPts];

	// End cap: semicircle at arc endpoint (x2, y2)
	const endRadial = startAngle + sweep;
	for (let j = 1; j < capSegs; j++) {
		const t = j / capSegs;
		const a = endRadial + t * Math.PI * sign;
		pts.push({ x: x2 + r * Math.cos(a), y: y2 + r * Math.sin(a) });
	}

	for (let i = innerPts.length - 1; i >= 0; i--) pts.push(innerPts[i]);

	// Start cap: semicircle at arc start point (x1, y1)
	for (let j = 1; j < capSegs; j++) {
		const t = j / capSegs;
		const a = startAngle + Math.PI + t * Math.PI * sign;
		pts.push({ x: x1 + r * Math.cos(a), y: y1 + r * Math.sin(a) });
	}

	return pts.length >= 3 ? pts : null;
}

export interface ComponentObstacles {
	silkscreenShapes: (number | string)[][];
	designatorBox: (number | string)[] | null;
	componentBBox: (number | string)[] | null;
	rawBBox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/**
 * Get all obstacles (designator, component bbox) for a single component.
 * Component pads are NOT extracted individually — the component bbox covers them.
 * Only returns obstacles if the component is on the same side as the target layer.
 */
export async function getComponentObstacles(
	component: IPCB_PrimitiveComponent,
	targetLayer: number,
): Promise<ComponentObstacles> {
	const obstacles: ComponentObstacles = {
		silkscreenShapes: [],
		designatorBox: null,
		componentBBox: null,
		rawBBox: null,
	};

	try {
		// Check component layer: 1=TOP, 2=BOTTOM
		const compLayer = component.getState_Layer?.();
		const isTopSide = targetLayer === 3; // 3=TOP_SILKSCREEN, 4=BOTTOM_SILKSCREEN

		// Skip if component is on the wrong side
		// compLayer: 1=TOP, 2=BOTTOM
		if (compLayer === 1 && !isTopSide) {
			// Component on TOP, but target is BOTTOM silkscreen
			return obstacles;
		}
		if (compLayer === 2 && isTopSide) {
			// Component on BOTTOM, but target is TOP silkscreen
			return obstacles;
		}

		// Get designator bounding box
		const designatorBox = await getDesignatorBoundingBox(component, targetLayer);
		if (designatorBox) {
			obstacles.designatorBox = designatorBox;
		}

		// Get component overall bounding box as rotated rectangle
		try {
			const compId = component.getState_PrimitiveId?.();
			const compRotation = component.getState_Rotation?.() ?? 0;

			if (compId) {
				const bbox = await eda.pcb_Primitive.getPrimitivesBBox([compId as any]);
				if (bbox) {
					obstacles.rawBBox = bbox;
					const bboxCx = (bbox.minX + bbox.maxX) / 2;
					const bboxCy = (bbox.minY + bbox.maxY) / 2;
					const bboxW = bbox.maxX - bbox.minX;
					const bboxH = bbox.maxY - bbox.minY;

					if (bboxW > 0 && bboxH > 0) {
						if (Math.abs(compRotation) < 0.01) {
							// No rotation — use BBox directly
							const points = createRectanglePolygon(bboxCx, bboxCy, bboxW, bboxH, 0);
							obstacles.componentBBox = pointsToSourceArray(points);
						}
						else {
							// Rotated — compute original unrotated size from rotated BBox
							const rad = compRotation * Math.PI / 180;
							const cosR = Math.abs(Math.cos(rad));
							const sinR = Math.abs(Math.sin(rad));
							const denom = cosR * cosR - sinR * sinR;
							if (Math.abs(denom) < 0.01) {
								const size = Math.max(bboxW, bboxH) / (cosR + sinR);
								const points = createRectanglePolygon(bboxCx, bboxCy, size, size, compRotation);
								obstacles.componentBBox = pointsToSourceArray(points);
							}
							else {
								const w = (bboxW * cosR - bboxH * sinR) / denom;
								const h = (bboxH * cosR - bboxW * sinR) / denom;
								if (w > 0 && h > 0) {
									const points = createRectanglePolygon(bboxCx, bboxCy, w, h, compRotation);
									obstacles.componentBBox = pointsToSourceArray(points);
								}
								else {
									const points = createRectanglePolygon(bboxCx, bboxCy, bboxW, bboxH, 0);
									obstacles.componentBBox = pointsToSourceArray(points);
								}
							}
						}
					}
				}
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get component bbox:', e);
		}
	}
	catch (e) {
		console.error(TAG, 'Failed to get component obstacles:', e);
	}

	return obstacles;
}

/**
 * Get all components from the PCB
 */
export async function getAllComponents(): Promise<IPCB_PrimitiveComponent[]> {
	try {
		const components = await eda.pcb_PrimitiveComponent.getAll();
		return components || [];
	}
	catch (e) {
		console.error(TAG, 'Failed to get components:', e);
		return [];
	}
}

/**
 * Get standalone pad polygons (pads not belonging to any component)
 * Uses pad shape data with rotation for accurate polygon
 * Filters pads by target layer: only includes pads on the same side or MULTI-layer pads
 * Returns { polygon, negateBisector } where negateBisector is:
 * - false for OVAL/OBROUND (CW winding in PCB coords)
 * - true for other shapes (CCW winding: RECT, ELLIPSE, NGON, POLYGON)
 */
export async function getStandalonePadPolygons(targetLayer: number): Promise<{ polygon: (number | string)[]; negateBisector: boolean }[]> {
	const result: { polygon: (number | string)[]; negateBisector: boolean }[] = [];
	try {
		const allPads = await eda.pcb_PrimitivePad.getAll();
		if (!allPads || allPads.length === 0) {
			console.warn(TAG, 'No standalone pads found');
			return result;
		}

		// 只保留游离焊盘（primitiveType === "Pad"），过滤掉器件焊盘（"ComponentPad"）
		const pads = allPads.filter((pad) => {
			const pt = pad.getState_PrimitiveType?.();
			return pt === 'Pad' || pt === undefined;
		});

		console.warn(TAG, `Found ${allPads.length} total pads, ${pads.length} standalone`);

		const isTopSide = targetLayer === 3; // 3=TOP_SILKSCREEN, 4=BOTTOM_SILKSCREEN

		for (let idx = 0; idx < pads.length; idx++) {
			const pad = pads[idx];
			try {
				// Check pad layer: 1=TOP, 2=BOTTOM, 12=MULTI
				const padLayer = pad.getState_Layer?.();

				// Skip if pad is on the wrong side (but include MULTI-layer pads)
				if (padLayer === 1 && !isTopSide) {
					// Pad on TOP, but target is BOTTOM silkscreen
					continue;
				}
				if (padLayer === 2 && isTopSide) {
					// Pad on BOTTOM, but target is TOP silkscreen
					continue;
				}
				// padLayer === 12 (MULTI) → always include

				const x = pad.getState_X?.() ?? 0;
				const y = pad.getState_Y?.() ?? 0;
				const rotation = pad.getState_Rotation?.() ?? 0;
				const padShape = pad.getState_Pad?.();

				if (!padShape || padShape.length < 2)
					continue;

				const shapeType = padShape[0];

				// OVAL pads are CW (negate=false); all other shapes are CCW (negate=true)
				// In PCB coords (Y-down): OVAL obround semicircles trace CW, rectangles trace CCW
				const negateBisector = (shapeType !== 'OVAL');

				// POLYGON 类型：直接使用源数组数据（已经是世界坐标）
				if (shapeType === 'POLYGON') {
					const polyData = padShape[1] as (number | string)[];
					if (polyData && polyData.length >= 4) {
						const pts = sourceArrayToPoints(polyData);
						if (pts.length >= 3) {
							result.push({ polygon: pointsToSourceArray(pts), negateBisector });
						}
					}
					continue;
				}

				// 其他类型：使用 pad shape 数据 + 旋转生成多边形
				// getState_Rotation() 返回的是弧度，转为度数
				const rotationDeg = rotation * 180 / Math.PI;
				const points = createPadPolygon(padShape, x, y, rotationDeg);
				if (points && points.length >= 3) {
					result.push({ polygon: pointsToSourceArray(points), negateBisector });
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process standalone pad:', e);
			}
		}
	}
	catch (e) {
		console.error(TAG, 'Failed to get standalone pads:', e);
	}
	return result;
}

/**
 * Get component pad polygons (pads belonging to components, not standalone)
 * Used when componentBBox is unchecked — avoids by individual pads instead of whole bbox
 */
export async function getComponentPadPolygons(targetLayer: number): Promise<{ polygon: (number | string)[]; negateBisector: boolean }[]> {
	const result: { polygon: (number | string)[]; negateBisector: boolean }[] = [];
	try {
		const allPads = await eda.pcb_PrimitivePad.getAll();
		if (!allPads || allPads.length === 0)
			return result;

		const pads = allPads.filter((pad) => {
			const pt = pad.getState_PrimitiveType?.();
			return pt === 'ComponentPad';
		});

		const isTopSide = targetLayer === 3;

		for (const pad of pads) {
			try {
				const padLayer = pad.getState_Layer?.();
				if (padLayer === 1 && !isTopSide) continue;
				if (padLayer === 2 && isTopSide) continue;

				const x = pad.getState_X?.() ?? 0;
				const y = pad.getState_Y?.() ?? 0;
				const rotation = pad.getState_Rotation?.() ?? 0;
				const padShape = pad.getState_Pad?.();

				if (!padShape || padShape.length < 2)
					continue;

				const shapeType = padShape[0];
				const negateBisector = (shapeType !== 'OVAL');

				if (shapeType === 'POLYGON') {
					const polyData = padShape[1] as (number | string)[];
					if (polyData && polyData.length >= 4) {
						const pts = sourceArrayToPoints(polyData);
						if (pts.length >= 3) {
							result.push({ polygon: pointsToSourceArray(pts), negateBisector });
						}
					}
					continue;
				}

				const rotationDeg = rotation * 180 / Math.PI;
				const points = createPadPolygon(padShape, x, y, rotationDeg);
				if (points && points.length >= 3) {
					result.push({ polygon: pointsToSourceArray(points), negateBisector });
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process component pad:', e);
			}
		}
		console.warn(TAG, `Component pads: ${pads.length} total, ${result.length} valid on layer`);
	}
	catch (e) {
		console.error(TAG, 'Failed to get component pads:', e);
	}
	return result;
}

/**
 * Get cutout region polygons (Fill on MULTI layer = 挖槽区域)
 */
export async function getCutoutRegionPolygons(): Promise<(number | string)[][]> {
	const polygons: (number | string)[][] = [];
	try {
		const fills = await eda.pcb_PrimitiveFill.getAll(12 as any);
		if (!fills || fills.length === 0) {
			console.warn(TAG, 'No cutout regions (Fill on MULTI layer) found');
			return polygons;
		}
		console.warn(TAG, `Found ${fills.length} cutout regions (Fill on MULTI)`);

		for (let idx = 0; idx < fills.length; idx++) {
			const fill = fills[idx];
			try {
				const polygon = (fill as any).getState_ComplexPolygon?.();
				if (!polygon) {
					console.warn(TAG, `Cutout #${idx}: no complex polygon`);
					continue;
				}
				const source = polygon.getSource?.();
				if (!source || source.length < 2) {
					console.warn(TAG, `Cutout #${idx}: source empty or too short (len=${source?.length})`);
					continue;
				}
				if (idx < 3) {
					console.warn(TAG, `Cutout #${idx} source tokens:`, JSON.stringify(source.slice(0, 30)));
				}
				const pts = sourceArrayToPoints(source);
				if (idx < 3) {
					console.warn(TAG, `Cutout #${idx}: ${pts.length} points extracted from source len=${source.length}`);
				}
				if (pts.length >= 3) {
					polygons.push(pointsToSourceArray(pts));
				}
				else {
					console.warn(TAG, `Cutout #${idx}: only ${pts.length} points, skipping`);
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process cutout region:', e);
			}
		}
		console.warn(TAG, `Processed ${polygons.length} cutout region polygons`);
	}
	catch (e) {
		console.warn(TAG, 'Failed to get cutout regions:', e);
	}
	return polygons;
}

/**
 * Get Region primitive polygons (禁止区域/约束区域)
 */
export async function getRegionPolygons(): Promise<(number | string)[][]> {
	const polygons: (number | string)[][] = [];
	try {
		const regions = await eda.pcb_PrimitiveRegion.getAll();
		if (!regions || regions.length === 0) {
			console.warn(TAG, 'No region primitives found');
			return polygons;
		}
		console.warn(TAG, `Found ${regions.length} region primitives`);

		for (let idx = 0; idx < regions.length; idx++) {
			const region = regions[idx];
			try {
				const polygon = (region as any).getState_ComplexPolygon?.();
				if (!polygon) {
					console.warn(TAG, `Region #${idx}: no complex polygon`);
					continue;
				}
				const source = polygon.getSource?.();
				if (!source || source.length < 2) {
					console.warn(TAG, `Region #${idx}: source empty or too short (len=${source?.length})`);
					continue;
				}
				if (idx < 3) {
					console.warn(TAG, `Region #${idx} source tokens:`, JSON.stringify(source.slice(0, 30)));
				}
				const pts = sourceArrayToPoints(source);
				if (idx < 3) {
					console.warn(TAG, `Region #${idx}: ${pts.length} points extracted from source len=${source.length}`);
				}
				if (pts.length >= 3) {
					polygons.push(pointsToSourceArray(pts));
				}
				else {
					console.warn(TAG, `Region #${idx}: only ${pts.length} points, skipping`);
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process region:', e);
			}
		}
		console.warn(TAG, `Processed ${polygons.length} region polygons`);
	}
	catch (e) {
		console.warn(TAG, 'Failed to get regions:', e);
	}
	return polygons;
}

/**
 * Get via polygons (circular, using outer diameter)
 */
export async function getViaPolygons(): Promise<(number | string)[][]> {
	const polygons: (number | string)[][] = [];
	try {
		const vias = await eda.pcb_PrimitiveVia.getAll();
		if (!vias || vias.length === 0) {
			console.warn(TAG, 'No vias found');
			return polygons;
		}
		console.warn(TAG, `Found ${vias.length} vias`);

		for (const via of vias) {
			try {
				const x = via.getState_X?.() ?? 0;
				const y = via.getState_Y?.() ?? 0;
				const diameter = via.getState_Diameter?.() ?? 0;
				if (diameter <= 0)
					continue;

				const pts = createCirclePolygon(x, y, diameter / 2, 8);
				if (pts.length >= 3) {
					polygons.push(pointsToSourceArray(pts));
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process via:', e);
			}
		}
		console.warn(TAG, `Processed ${polygons.length} via polygons`);
	}
	catch (e) {
		console.warn(TAG, 'Failed to get vias:', e);
	}
	return polygons;
}

/**
 * Get silkscreen text bounding boxes as rotated rectangles
 * Uses text position + font size + rotation to build accurate rotated rectangle
 */
export async function getSilkscreenTextBoxes(targetLayer: number): Promise<(number | string)[][]> {
	const polygons: (number | string)[][] = [];
	try {
		const strings = await eda.pcb_PrimitiveString.getAll(targetLayer as any);
		if (!strings || strings.length === 0) {
			console.warn(TAG, 'No string primitives found on layer', targetLayer);
			return polygons;
		}

		console.warn(TAG, `Found ${strings.length} string primitives on layer ${targetLayer}`);

		for (let i = 0; i < strings.length; i++) {
			const primString = strings[i];
			try {
				const text = primString.getState_Text?.() ?? '';
				if (!text || text.length === 0)
					continue;

				const primId = primString.getState_PrimitiveId?.();
				if (!primId)
					continue;

				const rotation = primString.getState_Rotation?.() ?? 0;

				// Use actual BBox from EDA
				const bbox = await eda.pcb_Primitive.getPrimitivesBBox([primId as any]);
				if (!bbox)
					continue;

				const bboxCx = (bbox.minX + bbox.maxX) / 2;
				const bboxCy = (bbox.minY + bbox.maxY) / 2;
				const bboxW = bbox.maxX - bbox.minX;
				const bboxH = bbox.maxY - bbox.minY;
				if (bboxW <= 0 || bboxH <= 0)
					continue;

				let points: Point[];

				if (Math.abs(rotation) < 0.01) {
					// No rotation — use BBox directly
					points = createRectanglePolygon(bboxCx, bboxCy, bboxW, bboxH, 0);
				}
				else {
					// Rotated — compute original unrotated size from rotated BBox
					const rad = rotation * Math.PI / 180;
					const cosR = Math.abs(Math.cos(rad));
					const sinR = Math.abs(Math.sin(rad));
					const denom = cosR * cosR - sinR * sinR;
					if (Math.abs(denom) < 0.01) {
						// ~45° rotation
						const size = Math.max(bboxW, bboxH) / (cosR + sinR);
						points = createRectanglePolygon(bboxCx, bboxCy, size, size, rotation);
					}
					else {
						const w = (bboxW * cosR - bboxH * sinR) / denom;
						const h = (bboxH * cosR - bboxW * sinR) / denom;
						if (w > 0 && h > 0) {
							points = createRectanglePolygon(bboxCx, bboxCy, w, h, rotation);
						}
						else {
							points = createRectanglePolygon(bboxCx, bboxCy, bboxW, bboxH, 0);
						}
					}
				}

				if (points.length >= 3) {
					polygons.push(pointsToSourceArray(points));
				}

				if (i < 3) {
					const pw = Math.sqrt((points[1].x - points[0].x) ** 2 + (points[1].y - points[0].y) ** 2);
					const ph = Math.sqrt((points[2].x - points[1].x) ** 2 + (points[2].y - points[1].y) ** 2);
					console.warn(TAG, `  Text "${text}" rot=${rotation}° bbox: ${pw.toFixed(0)}x${ph.toFixed(0)} at (${bboxCx.toFixed(1)}, ${bboxCy.toFixed(1)})`);
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process string primitive:', e);
			}
		}

		console.warn(TAG, `Processed ${polygons.length} text boxes on layer ${targetLayer}`);
	}
	catch (e) {
		console.error(TAG, 'Failed to get silkscreen text:', e);
	}
	return polygons;
}

/**
 * Get silkscreen text bounding boxes with rotation info for proper offset calculation
 * Returns { polygon, rotation }[] where rotation is needed for correct offset
 */
export async function getSilkscreenTextBoxesWithRotation(targetLayer: number, gap: number): Promise<{ polygon: (number | string)[]; rotation: number }[]> {
	const result: { polygon: (number | string)[]; rotation: number }[] = [];
	const LNAME = (l: number) => l === 1 ? 'TOP_COPPER' : l === 2 ? 'BOTTOM_COPPER' : l === 3 ? 'TOP_SILK' : l === 4 ? 'BOTTOM_SILK' : String(l);
	try {
		let strings: any[];
		try {
			strings = await eda.pcb_PrimitiveString.getAll();
		} catch (e) {
			try { strings = await eda.pcb_PrimitiveString.getAll(targetLayer as any); }
			catch (e2) { return result; }
		}

		if (!strings || !Array.isArray(strings) || strings.length === 0) return result;

		const filtered = strings.filter((s: any) => s.getState_Layer?.() === targetLayer);
		console.warn(TAG, );

		// Collect metadata and batch getPrimitivesBBox
		const textMeta: { primId: string; rotation: number }[] = [];
		for (const primString of filtered) {
			const text = primString.getState_Text?.() ?? '';
			if (!text) continue;
			const primId = primString.getState_PrimitiveId?.();
			if (!primId) continue;
			const rotation = primString.getState_Rotation?.() ?? 0;
			textMeta.push({ primId, rotation });
		}

		// Fetch all bboxes in parallel
		const bboxes = await Promise.all(
			textMeta.map(m => eda.pcb_Primitive.getPrimitivesBBox([m.primId as any]).catch(() => null))
		);

		for (let i = 0; i < textMeta.length; i++) {
			const bbox = bboxes[i];
			if (!bbox) continue;
			const { rotation } = textMeta[i];
			const bboxCx = (bbox.minX + bbox.maxX) / 2;
			const bboxCy = (bbox.minY + bbox.maxY) / 2;
			const bboxW = bbox.maxX - bbox.minX;
			const bboxH = bbox.maxY - bbox.minY;
			if (bboxW <= 0 || bboxH <= 0) continue;

			let points: Point[];
			if (Math.abs(rotation) < 0.01) {
				points = createRectanglePolygon(bboxCx, bboxCy, bboxW + 2 * gap, bboxH + 2 * gap, 0);
			} else {
				const rad = rotation * Math.PI / 180;
				const cosR = Math.abs(Math.cos(rad));
				const sinR = Math.abs(Math.sin(rad));
				const denom = cosR * cosR - sinR * sinR;
				let origW: number, origH: number;
				if (Math.abs(denom) < 0.01) {
					const size = Math.max(bboxW, bboxH) / (cosR + sinR);
					origW = size; origH = size;
				} else {
					origW = (bboxW * cosR - bboxH * sinR) / denom;
					origH = (bboxH * cosR - bboxW * sinR) / denom;
					if (origW <= 0 || origH <= 0) {
						points = createRectanglePolygon(bboxCx, bboxCy, bboxW + 2 * gap, bboxH + 2 * gap, 0);
						if (points.length >= 3) result.push({ polygon: pointsToSourceArray(points), rotation: 0 });
						continue;
					}
				}
				points = createRectanglePolygon(bboxCx, bboxCy, origW + 2 * gap, origH + 2 * gap, rotation);
			}
			if (points.length >= 3) result.push({ polygon: pointsToSourceArray(points), rotation: 0 });
		}

		console.warn(TAG, );
	} catch (e) {
		console.warn(TAG, 'Failed to get text:', e);
	}
	return result;
}

/**
 * Get polyline (线条) polygons on a given layer (silkscreen lines)
 * Fetches ALL polylines then filters by layer manually
 * Each polyline segment is expanded to a rounded-end shape (rectangle + semicircle caps)
 */
export async function getLinePolygons(layer: number): Promise<{ polygon: (number | string)[]; negateBisector: boolean }[]> {
	const result: { polygon: (number | string)[]; negateBisector: boolean }[] = [];
	const LNAME = (l: number) => l === 1 ? 'TOP_COPPER' : l === 2 ? 'BOTTOM_COPPER' : l === 3 ? 'TOP_SILK' : l === 4 ? 'BOTTOM_SILK' : String(l);
	try {
		const allPolylines = await eda.pcb_PrimitivePolyline.getAll();
		if (!allPolylines || allPolylines.length === 0) {
			console.warn(TAG, `No polylines found at all`);
			return result;
		}

		const polylines = allPolylines.filter((p: any) => {
			const l = p.layer ?? (p.getState_Layer ? p.getState_Layer() : undefined);
			return l === layer;
		});

		console.warn(TAG, `Found ${allPolylines.length} total polylines, ${polylines.length} on layer ${LNAME(layer)}`);

		for (const polyline of polylines) {
			try {
				const lineWidth = (polyline as any).lineWidth ?? (polyline.getState_LineWidth ? polyline.getState_LineWidth() : 0);
				const r = lineWidth / 2;
				if (r < 1) continue;

				const polygon = (polyline as any).getState_Polygon?.();
				if (!polygon) continue;

				const source = polygon.getSource?.();
				if (!source || source.length < 2) continue;

				const firstCmd = source.find((s: any) => typeof s === 'string');

				if (firstCmd === 'CIRCLE') {
					const idx = source.indexOf('CIRCLE');
					if (idx >= 0 && idx + 3 < source.length) {
						const ccx = source[idx + 1] as number;
						const ccy = source[idx + 2] as number;
						const cr = source[idx + 3] as number;
						const points = createCirclePolygon(ccx, ccy, cr + r, 12);
						if (points.length >= 3) {
							result.push({ polygon: pointsToSourceArray(points), negateBisector: false });
						}
					}
					continue;
				}

				if (firstCmd === 'R') {
					const pts = sourceArrayToPoints(source);
					if (pts.length === 4) {
						// Compute centroid
						let cx = 0, cy = 0;
						for (const p of pts) { cx += p.x; cy += p.y; }
						cx /= 4; cy /= 4;
						const expanded: Point[] = [];
						const n = pts.length;
						for (let j = 0; j < n; j++) {
							const prev = pts[(j - 1 + n) % n];
							const curr = pts[j];
							const next = pts[(j + 1) % n];
							const e1x = curr.x - prev.x, e1y = curr.y - prev.y;
							const e2x = next.x - curr.x, e2y = next.y - curr.y;
							const len1 = Math.sqrt(e1x * e1x + e1y * e1y);
							const len2 = Math.sqrt(e2x * e2x + e2y * e2y);
							if (len1 < 1e-6 || len2 < 1e-6) { expanded.push(curr); continue; }
							// Try both normal directions, pick the one pointing away from centroid
							let n1x = -e1y / len1, n1y = e1x / len1;
							const testX = curr.x + n1x;
							const testY = curr.y + n1y;
							const distBefore = (curr.x - cx) ** 2 + (curr.y - cy) ** 2;
							const distAfter = (testX - cx) ** 2 + (testY - cy) ** 2;
							if (distAfter < distBefore) {
								n1x = -n1x; n1y = -n1y;
							}
							let n2x = -e2y / len2, n2y = e2x / len2;
							const test2X = curr.x + n2x;
							const test2Y = curr.y + n2y;
							const dist2After = (test2X - cx) ** 2 + (test2Y - cy) ** 2;
							if (dist2After < distBefore) {
								n2x = -n2x; n2y = -n2y;
							}
							const bx = n1x + n2x, by = n1y + n2y;
							const blen = Math.sqrt(bx * bx + by * by);
							if (blen < 1e-6) {
								expanded.push({ x: curr.x + n1x * r, y: curr.y + n1y * r });
							}
							else {
								const dot = n1x * n2x + n1y * n2y;
								const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2));
								const offset = cosHalf > 0.01 ? r / cosHalf : r;
								expanded.push({ x: curr.x + (bx / blen) * offset, y: curr.y + (by / blen) * offset });
							}
						}
						result.push({ polygon: pointsToSourceArray(expanded), negateBisector: false });
					}
					continue;
				}

				const points = sourceArrayToPoints(source);
				if (points.length < 2) continue;

				for (let i = 0; i < points.length - 1; i++) {
					const pts = createLineCapsule(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, lineWidth);
					if (pts) result.push({ polygon: pointsToSourceArray(pts), negateBisector: false });
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to process polyline:', e);
			}
		}
		console.warn(TAG, `Processed ${result.length} line polygons on layer ${LNAME(layer)}`);
	}
	catch (e) {
		console.error(TAG, `Failed to get lines on layer ${LNAME(layer)}:`, e);
	}
	return result;
}

/**
 * Get copper track (导线) polygons on a given layer
 * Fetches ALL tracks then filters by layer manually
 * Each track segment is expanded to a rounded-end shape
 */
export async function getTrackPolygons(layer: number): Promise<(number | string)[][]> {
	const polygons: (number | string)[][] = [];
	const LNAME = (l: number) => l === 1 ? 'TOP_COPPER' : l === 2 ? 'BOTTOM_COPPER' : l === 3 ? 'TOP_SILK' : l === 4 ? 'BOTTOM_SILK' : String(l);
	try {
		const [allTracks, allArcs] = await Promise.all([
			eda.pcb_PrimitiveLine.getAll().catch(() => []),
			eda.pcb_PrimitiveArc.getAll().catch(() => []),
		]);

		// Straight tracks
		const tracks = (allTracks || []).filter((t: any) => {
			const l = t.layer ?? (t.getState_Layer ? t.getState_Layer() : undefined);
			return l === layer;
		});

		for (const track of tracks) {
			try {
				const x1 = (track as any).startX ?? (track as any).x1 ?? (track.getState_StartX ? track.getState_StartX() : 0);
				const y1 = (track as any).startY ?? (track as any).y1 ?? (track.getState_StartY ? track.getState_StartY() : 0);
				const x2 = (track as any).endX ?? (track as any).x2 ?? (track.getState_EndX ? track.getState_EndX() : 0);
				const y2 = (track as any).endY ?? (track as any).y2 ?? (track.getState_EndY ? track.getState_EndY() : 0);
				const lineWidth = (track as any).lineWidth ?? (track.getState_LineWidth ? track.getState_LineWidth() : 0);
				const pts = createLineCapsule(x1, y1, x2, y2, lineWidth);
				if (pts) polygons.push(pointsToSourceArray(pts));
			}
			catch (e) {
				console.warn(TAG, 'Failed to process track:', e);
			}
		}

		// Arc tracks
		const arcs = (allArcs || []).filter((a: any) => {
			const l = a.layer ?? (a.getState_Layer ? a.getState_Layer() : undefined);
			return l === layer;
		});

		for (const arc of arcs) {
			try {
				const x1 = (arc as any).startX ?? (arc.getState_StartX ? arc.getState_StartX() : 0);
				const y1 = (arc as any).startY ?? (arc.getState_StartY ? arc.getState_StartY() : 0);
				const x2 = (arc as any).endX ?? (arc.getState_EndX ? arc.getState_EndX() : 0);
				const y2 = (arc as any).endY ?? (arc.getState_EndY ? arc.getState_EndY() : 0);
				const arcAngle = (arc as any).arcAngle ?? (arc.getState_ArcAngle ? arc.getState_ArcAngle() : 0);
				const lineWidth = (arc as any).lineWidth ?? (arc.getState_LineWidth ? arc.getState_LineWidth() : 0);
				const pts = createArcCapsule(x1, y1, x2, y2, arcAngle, lineWidth);
				if (pts) polygons.push(pointsToSourceArray(pts));
			}
			catch (e) {
				console.warn(TAG, 'Failed to process arc track:', e);
			}
		}

		console.warn(TAG, `Tracks on ${LNAME(layer)}: ${tracks.length} lines + ${arcs.length} arcs → ${polygons.length} polygons`);
	}
	catch (e) {
		console.error(TAG, `Failed to get tracks on layer ${LNAME(layer)}:`, e);
	}
	return polygons;
}
