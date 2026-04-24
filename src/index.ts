/**
 * 动态丝印填充扩展
 * Dynamic Silkscreen Fill Region Extension
 *
 * 交互式绘制多边形区域，自动布尔运算去除障碍物（焊盘、位号等）
 */

import type { Point } from './utils/polygonUtils';
import { createFillPrimitiveWithFix } from './core/booleanOperation';
import { getAllComponents, getComponentObstacles, getComponentPadPolygons, getCutoutRegionPolygons, getLinePolygons, getRegionPolygons, getSilkscreenTextBoxesWithRotation, getStandalonePadPolygons, getTrackPolygons, getViaPolygons } from './core/obstacleCollector';
import { clipObstaclesToRegionWithMeta, mergeOverlappingObstacles, subtractHolesFromRegionIncremental } from './core/polygonBoolean';
import { offsetObstacles } from './core/polygonOffset';
import { LAYER_BOTTOM_COPPER, LAYER_BOTTOM_SILKSCREEN, LAYER_TOP_COPPER, LAYER_TOP_SILKSCREEN } from './utils/constants';
import { aabbIntersects, calculateBoundingBox, ensureClockwise, ensureCounterClockwise, pointsToSourceArray, sourceArrayToPoints } from './utils/polygonUtils';

const TAG = '[DynamicFill]';

let currentState: 'IDLE' | 'DRAWING' = 'IDLE';

let currentGap: number = 10;
interface ObstacleOptions {
	componentBBox: boolean;
	vias: boolean;
	pads: boolean;
	cutouts: boolean;
	textCopper: boolean;
	textSilk: boolean;
	linesSilk: boolean;
	linesCopper: boolean;
	tracksCopper: boolean;
}

let currentOptions: ObstacleOptions = { componentBBox: true, vias: true, pads: true, cutouts: true, textCopper: true, textSilk: true, linesSilk: true, linesCopper: true, tracksCopper: true };
let currentPoints: Point[] = [];
let targetLayer: number = LAYER_TOP_SILKSCREEN;
let fillCount: number = 0;

// 临时填充图元 ID（用户绘制的原始填充区域）
let tempFillId: string | null = null;

const IFRAME_ID = 'dynamic-fill-panel';
const POLL_TIMER_ID = '__df_poll';
const EVENT_ID = '__df_event';

const _g: any = (typeof window !== 'undefined') ? window : globalThis;

function sendStatus(type: string, data: Record<string, any> = {}): void {
	try {
		_g.__df_status = { type, ...data };
	}
	catch (e) {
		console.warn(TAG, 'Failed to send status:', e);
	}
}

function cleanupListeners(): void {
	try {
		eda.pcb_Event.removeEventListener(EVENT_ID);
	}
	catch (e) {
		// ignore
	}
}

/**
 * 删除临时填充图元
 */
async function deleteTempFill(): Promise<void> {
	if (tempFillId) {
		try {
			await eda.pcb_PrimitiveFill.delete(tempFillId);
		}
		catch (e) {
			console.warn(TAG, 'Failed to delete temp fill:', e);
		}
		tempFillId = null;
	}
}

/**
 * 在当前鼠标位置添加一个点
 */
async function addPointAtCursor(): Promise<void> {
	try {
		const pos = await eda.pcb_SelectControl.getCurrentMousePosition();
		if (!pos)
			return;

		// 防止重复添加（两次调用间隔太短）
		if (currentPoints.length > 0) {
			const last = currentPoints[currentPoints.length - 1];
			if (Math.abs(last.x - pos.x) < 5 && Math.abs(last.y - pos.y) < 5) {
				console.warn(TAG, 'Point too close to last, skipping');
				return;
			}
		}
		currentPoints.push({ x: pos.x, y: pos.y });
		console.warn(TAG, `Point #${currentPoints.length}: (${pos.x}, ${pos.y})`);
	}
	catch (e) {
		console.warn(TAG, 'Failed to add point:', e);
	}
}

/**
 * 轮询来自 IFrame 的命令
 */
async function pollCommands(): Promise<void> {
	try {
		const cmd = _g.__df_cmd;
		if (cmd) {
			delete _g.__df_cmd;

			if (cmd.type === 'start') {
				eda.sys_Message.showToastMessage('请左键点击3个及以上轮廓点', 'info', 3);
				console.warn(TAG, `Start command received, gap=${cmd.gap}`);

				currentGap = cmd.gap || 0;
				currentOptions = cmd.options || { vias: true, pads: true, cutouts: true, textCopper: true, textSilk: true, linesSilk: true, linesCopper: true, tracksCopper: true };
				targetLayer = cmd.layer ?? LAYER_TOP_SILKSCREEN;
				console.warn(TAG, `Options: linesSilk=${currentOptions.linesSilk}, linesCopper=${currentOptions.linesCopper}, tracksCopper=${currentOptions.tracksCopper}`);
				console.warn(TAG, `Target layer: ${targetLayer === LAYER_TOP_SILKSCREEN ? 'TOP' : 'BOTTOM'} silkscreen`);
				currentPoints = [];
				currentState = 'DRAWING';
				tempFillId = null;

				// 注册 pcb_Event 监听器：点击画布时拾取点
				try {
					eda.pcb_Event.addMouseEventListener(
						EVENT_ID,
						'all',
						async (eventType: string, _props: any[]) => {
							if (currentState !== 'DRAWING')
								return;
							if (eventType === 'selected') {
								try {
									await addPointAtCursor();
								}
								catch (e) {
									console.warn(TAG, 'Mouse event error:', e);
								}
							}
						},
					);
					console.warn(TAG, 'Mouse event listener registered');
				}
				catch (e) {
					console.warn(TAG, 'Failed to register mouse listener:', e);
				}
			}
			else if (cmd.type === 'stop') {
				console.warn(TAG, 'Stop command received');

				currentState = 'IDLE';
				currentPoints = [];
				await deleteTempFill();
				cleanupListeners();
			}
			else if (cmd.type === 'finish') {
				console.warn(TAG, 'Finish polygon command received');
				if (currentState === 'DRAWING') {
					const success = await finishCurrentPolygon();
					if (success) {
						currentState = 'IDLE';
						cleanupListeners();
					}
				}
			}
			else if (cmd.type === 'fillAvoid') {
				await handleFillAvoid(cmd.gap, cmd.options);
			}
		}
	}
	catch (e) {
		console.warn(TAG, 'Poll error:', e);
	}
}

/**
 * 根据选中填充区域进行避让填充
 * 步骤1: 检测是否有选中图元
 * 步骤2: 检测是否是填充区域
 * 步骤3: 检测是否是顶层或底层丝印层
 */
async function handleFillAvoid(gap: number, options: ObstacleOptions): Promise<boolean> {
	const startTime = Date.now();
	try {
		// 步骤1: 获取选中的图元列表
		let selectedPrimitives: any[] = [];
		try {
			const result = await eda.pcb_SelectControl.getAllSelectedPrimitives();
			if (Array.isArray(result)) {
				selectedPrimitives = result;
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get selected primitives:', e);
		}

		console.warn(TAG, 'handleFillAvoid: selectedPrimitives count =', selectedPrimitives.length);

		// 步骤1: 没有选中任何图元
		if (selectedPrimitives.length === 0) {
			eda.sys_Message.showToastMessage('请选中丝印层填充区域再重试', 'info', 3);
			return false;
		}

		// 步骤2: 遍历选中图元，检测是否是填充区域
		let selectedFill: any = null;
		let fillLayer = 0;
		let polygonSourceArray: (number | string)[] | null = null;

		for (const prim of selectedPrimitives) {
			if (!prim) continue;

			const primitiveType = prim.primitiveType;
			const layer = prim.layer;
			const regionName = prim.regionName;
			console.warn(TAG, 'handleFillAvoid: type =', primitiveType, 'layer =', layer, 'regionName =', regionName);

			// 步骤3: 检测是否是丝印层
			if (layer !== LAYER_TOP_SILKSCREEN && layer !== LAYER_BOTTOM_SILKSCREEN) {
				console.warn(TAG, 'Not silk layer, skipping');
				continue;
			}

			// 步骤2: 检测是否是填充区域 - primitiveType=Region 且 regionName=Fill Region
			if (primitiveType === 'Region' && regionName === 'Fill Region') {
				const complexPolygon = prim.complexPolygon;
				if (complexPolygon && complexPolygon.polygon) {
					const poly = complexPolygon.polygon;
					if (poly.length > 0) {
						selectedFill = prim;
						fillLayer = layer;
						polygonSourceArray = poly;
						console.warn(TAG, 'handleFillAvoid: Found fill region on layer', layer);
						break;
					}
				}
			}
		}

		// 步骤2: 没有找到填充
		if (!selectedFill) {
			eda.sys_Message.showToastMessage('请选中丝印层填充区域再重试', 'info', 3);
			return false;
		}

		console.warn(TAG, 'handleFillAvoid: fill found on layer', fillLayer);

		// 转换为 Point[]
		const fillPoints = sourceArrayToPoints(polygonSourceArray!);
		if (fillPoints.length < 3) {
			eda.sys_Message.showToastMessage('填充区域几何数据无效', 'warning', 3);
			return false;
		}

		console.warn(TAG, 'handleFillAvoid: Fill has', fillPoints.length, 'polygon points');

		// 检测通过，开始处理
		eda.sys_Message.showToastMessage('正在处理填充避让...', 'info', 3);

		// 收集障碍物（使用选中填充的层）
		const tc0 = Date.now();
		const allObstacles = await collectAllObstacles(fillLayer, options, gap);
		const tc1 = Date.now();
		console.warn(TAG, `[perf] Collect obstacles: ${allObstacles.length} in ${tc1 - tc0}ms`);

		// 转换为 Point[]
		const obstaclePoints: Point[][] = [];
		const obstacleRotations: number[] = [];
		const obstacleNegateBisector: boolean[] = [];
		const obstacleExtraGaps: number[] = [];
		for (const obs of allObstacles) {
			try {
				const pts = sourceArrayToPoints(obs.polygon);
				if (pts.length >= 3) {
					obstaclePoints.push(pts);
					obstacleRotations.push(obs.rotation);
					obstacleNegateBisector.push(obs.negateBisector);
					obstacleExtraGaps.push(obs.extraGap ?? gap);
				}
			}
			catch (e) { /* skip */ }
		}

		// 布尔差运算：填充区域减去障碍物
		let results: { outer: Point[]; holes: Point[][] }[] = [{ outer: fillPoints, holes: [] }];
		if (obstaclePoints.length > 0) {
			const fillRegionCW = ensureClockwise(fillPoints);
			results = await processObstaclePipeline(
				fillRegionCW, obstaclePoints, obstacleRotations, obstacleNegateBisector, obstacleExtraGaps, gap,
			);
		}
		// 删除原填充
		const fillId = selectedFill.primitiveId;
		if (fillId) {
			await eda.pcb_PrimitiveFill.delete(fillId);
			console.warn(TAG, 'handleFillAvoid: Deleted original fill:', fillId);
		}

		// 创建新填充
		eda.sys_Message.showToastMessage('正在创建填充...', 'info', 3);
		let created = 0;
		for (const result of results) {
			try {
				const outerSource = pointsToSourceArray(ensureClockwise(result.outer));
				const holeSources = result.holes.map(h => pointsToSourceArray(ensureCounterClockwise(h)));
				const complexPolyArray = [outerSource, ...holeSources];
				const fill = await createFillPrimitiveWithFix(fillLayer, complexPolyArray);
				if (fill) created++;
			}
			catch (e) {
				console.warn(TAG, 'handleFillAvoid: Failed to create fill:', e);
			}
		}

		console.warn(TAG, 'handleFillAvoid: Created', created, 'fill(s)');
		const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
		console.warn(TAG, `[perf] 填充避让总耗时: ${totalTime}s`);
		eda.sys_Message.showToastMessage(`填充避让完成，耗时 ${totalTime}s`, 'info', 5);
		return created > 0;
	}
	catch (e) {
		console.error(TAG, 'handleFillAvoid failed:', e);
		eda.sys_Message.showToastMessage('错误: ' + (e instanceof Error ? e.message : String(e)), 'error', 3);
		return false;
	}
}
/**
 * 完成当前多边形：创建临时填充 → 布尔运算 → 删除临时填充 → 写入最终填充
 * @returns true if fill was created successfully
 */
async function finishCurrentPolygon(): Promise<boolean> {
	if (currentPoints.length < 3) {
		eda.sys_Message.showToastMessage('至少需要3个点才能完成多边形', 'warning', 3);
		return false;
	}

	const points = [...currentPoints];
	currentPoints = [];

	eda.sys_Message.showToastMessage('正在收集障碍物...', 'info', 3);

	try {
		// 1. 创建临时填充（用户绘制的原始多边形）
		const outerPoints = ensureClockwise(points);
		const outerSource = pointsToSourceArray(outerPoints);
		const tempComplex = eda.pcb_MathPolygon.createComplexPolygon([outerSource] as any);
		if (!tempComplex) {
			eda.sys_Message.showToastMessage('错误: 无法构建多边形', 'error', 3);
			return false;
		}

		const tempFill = await eda.pcb_PrimitiveFill.create(
			targetLayer as any,
			tempComplex,
			'',
			undefined,
			10,
			false,
		);

		if (!tempFill) {
			eda.sys_Message.showToastMessage('错误: 无法创建绘制区域', 'error', 3);
			return false;
		}

		tempFillId = tempFill.getState_PrimitiveId();
		console.warn(TAG, `Temp fill created: ${tempFillId}`);

		// 2. 收集障碍物并执行布尔运算
		const success = await processPolygonFill(points, currentGap);

		// 3. 删除临时填充
		await deleteTempFill();

		if (!success) {
			eda.sys_Message.showToastMessage('创建失败，请重试', 'warning', 3);
		}
		return success;
	}
	catch (e) {
		console.error(TAG, 'Failed to finish polygon:', e);
		await deleteTempFill();
		eda.sys_Message.showToastMessage(`错误: ${e instanceof Error ? e.message : String(e)}`, 'error', 3);
		return false;
	}
}

/**
 * Obstacle with rotation angle for proper offset calculation
 */
interface ObstacleWithRotation {
	polygon: (number | string)[];
	rotation: number; // degrees, 0 = no rotation
	negateBisector: boolean; // true for CCW polygons (rect/circle), false for CW polygons or CCW capsules (line-shape)
	extraGap?: number; // additional gap beyond the standard gap (used for text which already has gap baked in)
}

/**
 * 收集 PCB 上所有障碍物
 */
async function collectAllObstacles(layer: number, options: ObstacleOptions, gap: number): Promise<ObstacleWithRotation[]> {
	const allObstacles: ObstacleWithRotation[] = [];
	const copperLayer = layer === LAYER_BOTTOM_SILKSCREEN ? LAYER_BOTTOM_COPPER : LAYER_TOP_COPPER;

	// 并行获取所有障碍物数据
	const [
		components,
		standalonePads,
		componentPads,
		vias,
		copperTexts,
		silkTexts,
		cutouts,
		silkLines,
		copperLines,
		copperTracks,
		regions,
	] = await Promise.all([
		getAllComponents().catch((e) => { console.warn(TAG, 'getAllComponents failed:', e); return []; }),
		options.pads ? getStandalonePadPolygons(layer).catch((e) => { console.warn(TAG, 'getStandalonePadPolygons failed:', e); return []; }) : Promise.resolve([]),
		!options.componentBBox ? getComponentPadPolygons(layer).catch((e) => { console.warn(TAG, 'getComponentPadPolygons failed:', e); return []; }) : Promise.resolve([]),
		options.vias ? getViaPolygons().catch((e) => { console.warn(TAG, 'getViaPolygons failed:', e); return []; }) : Promise.resolve([]),
		options.textCopper ? getSilkscreenTextBoxesWithRotation(copperLayer, gap).catch((e) => { console.warn(TAG, 'getCopperTexts failed:', e); return []; }) : Promise.resolve([]),
		options.textSilk ? getSilkscreenTextBoxesWithRotation(layer, gap).catch((e) => { console.warn(TAG, 'getSilkTexts failed:', e); return []; }) : Promise.resolve([]),
		options.cutouts ? getCutoutRegionPolygons().catch((e) => { console.warn(TAG, 'getCutouts failed:', e); return []; }) : Promise.resolve([]),
		options.linesSilk ? getLinePolygons(layer).catch((e) => { console.warn(TAG, 'getSilkLines failed:', e); return []; }) : Promise.resolve([]),
		options.linesCopper ? getLinePolygons(copperLayer).catch((e) => { console.warn(TAG, 'getCopperLines failed:', e); return []; }) : Promise.resolve([]),
		options.tracksCopper ? getTrackPolygons(copperLayer).catch((e) => { console.warn(TAG, 'getCopperTracks failed:', e); return []; }) : Promise.resolve([]),
		getRegionPolygons().catch((e) => { console.warn(TAG, 'getRegions failed:', e); return []; }),
	]);

	// 处理组件（含位号）— 并行获取所有组件障碍物
	const componentObstacleResults = await Promise.all(
		components.map(comp =>
			getComponentObstacles(comp, layer).catch((e) => {
				console.warn(TAG, 'Failed to get component obstacles:', e);
				return { designatorBox: null, componentBBox: null, silkscreenShapes: [] };
			}),
		),
	);

	// 收集组件 bbox 用于过滤封装内焊盘
	const compBBoxes: { minX: number; minY: number; maxX: number; maxY: number }[] = [];
	let compDesignator = 0; let compBBox = 0;
	for (let ci = 0; ci < components.length; ci++) {
		const obstacles = componentObstacleResults[ci];
		if (obstacles.designatorBox) {
			allObstacles.push({ polygon: obstacles.designatorBox, rotation: 0, negateBisector: true });
			compDesignator++;
		}
		if (options.componentBBox && obstacles.componentBBox) {
			allObstacles.push({ polygon: obstacles.componentBBox, rotation: 0, negateBisector: false });
			compBBox++;
		}
		// 收集组件 bbox 用于过滤焊盘
		const compId = components[ci].getState_PrimitiveId?.();
		if (compId) {
			try {
				const bbox = await eda.pcb_Primitive.getPrimitivesBBox([compId as any]);
				if (bbox) compBBoxes.push(bbox);
			}
			catch (_) {}
		}
	}
	console.warn(TAG, `Components: ${components.length} comps, ${compDesignator} designators, ${compBBox} bboxes`);

	// 封装内焊盘（仅当不使用封装BBox时）
	if (!options.componentBBox) {
		for (const pad of componentPads) {
			allObstacles.push({ polygon: pad.polygon, rotation: 0, negateBisector: pad.negateBisector });
		}
		console.warn(TAG, `Component pads (instead of bbox): ${componentPads.length}`);
	}

	// 过滤封装内焊盘，只保留真正的游离焊盘
	let padFiltered = 0;
	for (const pad of standalonePads) {
		const pts = sourceArrayToPoints(pad.polygon);
		if (pts.length === 0) continue;
		const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
		const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
		let insideComp = false;
		for (const bb of compBBoxes) {
			if (cx >= bb.minX && cx <= bb.maxX && cy >= bb.minY && cy <= bb.maxY) {
				insideComp = true;
				break;
			}
		}
		if (insideComp && options.componentBBox) {
			padFiltered++;
			continue;
		}
		allObstacles.push({ polygon: pad.polygon, rotation: 0, negateBisector: false });
	}
	console.warn(TAG, `Standalone pads: ${standalonePads.length}, filtered ${padFiltered} inside components`);

	// 过滤封装内过孔
	let viaFiltered = 0;
	for (const via of vias) {
		const pts = sourceArrayToPoints(via);
		if (pts.length === 0) { allObstacles.push({ polygon: via, rotation: 0, negateBisector: false }); continue; }
		const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
		const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
		let insideComp = false;
		if (options.componentBBox) {
			for (const bb of compBBoxes) {
				if (cx >= bb.minX && cx <= bb.maxX && cy >= bb.minY && cy <= bb.maxY) {
					insideComp = true;
					break;
				}
			}
		}
		if (insideComp) { viaFiltered++; continue; }
		allObstacles.push({ polygon: via, rotation: 0, negateBisector: false });
	}
	console.warn(TAG, `Vias: ${vias.length}, filtered ${viaFiltered} inside components`);

	for (const t of copperTexts) {
		allObstacles.push({ polygon: t.polygon, rotation: t.rotation, negateBisector: false, extraGap: 0 });
	}
	for (const t of silkTexts) {
		allObstacles.push({ polygon: t.polygon, rotation: t.rotation, negateBisector: true, extraGap: 0 });
	}
	console.warn(TAG, `Text boxes: ${copperTexts.length} copper + ${silkTexts.length} silk`);

	for (const cutout of cutouts) {
		allObstacles.push({ polygon: cutout, rotation: 0, negateBisector: false });
	}
	console.warn(TAG, `Cutout regions: ${cutouts.length}`);

	for (const line of silkLines) {
		allObstacles.push({ polygon: line.polygon, rotation: 0, negateBisector: line.negateBisector });
	}
	console.warn(TAG, `Silkscreen lines: ${silkLines.length}`);

	for (const line of copperLines) {
		allObstacles.push({ polygon: line.polygon, rotation: 0, negateBisector: line.negateBisector });
	}
	console.warn(TAG, `Copper lines: ${copperLines.length}`);

	for (const track of copperTracks) {
		allObstacles.push({ polygon: track, rotation: 0, negateBisector: false });
	}
	console.warn(TAG, `Copper tracks: ${copperTracks.length}`);

	for (const region of regions) {
		allObstacles.push({ polygon: region, rotation: 0, negateBisector: false });
	}
	console.warn(TAG, `Region primitives: ${regions.length}`);

	// 去重：designator 和 text 可能指向同一个 primitive，导致同一障碍物被添加两次
	const seen = new Set<string>();
	const unique: ObstacleWithRotation[] = [];
	for (const obs of allObstacles) {
		const key = obs.polygon.join(',');
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(obs);
		}
	}

	console.warn(TAG, `Collected ${allObstacles.length} obstacles, ${unique.length} unique`);
	return unique;
}

/**
 * 从用户点构建复杂多边形，去除障碍物，创建填充
 *
 * 流程：
 * 1. 收集所有挖洞图元的位置和几何信息
 * 2. 根据图元角度做旋转变换（已含在图元数据中）
 * 3. 裁剪到用户绘制区域内（区域外的图元不参与）
 * 4. 根据间隙外扩挖洞区域
 * 5. 合并重叠的挖洞区域（union）
 * 6. 用户绘制填充区域与挖洞区域布尔差集
 */
async function processPolygonFill(userPoints: Point[], gap: number): Promise<boolean> {
	const startTime = Date.now();
	if (userPoints.length < 3) {
		eda.sys_Message.showToastMessage('错误: 至少需要3个点', 'error', 3);
		return false;
	}

	try {
		// 步骤 1-2：收集障碍物
		eda.sys_Message.showToastMessage('正在收集障碍物...', 'info', 3);
		const allObstacles = await collectAllObstacles(targetLayer, currentOptions, gap);

		// 转换为 Point[] 用于后续处理，保留旋转角度用于外扩
		const obstaclePoints: Point[][] = [];
		const obstacleRotations: number[] = [];
		const obstacleNegateBisector: boolean[] = [];
		const obstacleExtraGaps: number[] = [];
		for (const obs of allObstacles) {
			try {
				const pts = sourceArrayToPoints(obs.polygon);
				if (pts.length >= 3) {
					obstaclePoints.push(pts);
					obstacleRotations.push(obs.rotation);
					obstacleNegateBisector.push(obs.negateBisector);
					obstacleExtraGaps.push(obs.extraGap ?? gap);
				}
			}
			catch (e) { /* skip */ }
		}

		console.warn(TAG, `Obstacles: ${allObstacles.length} collected, ${obstaclePoints.length} valid polygons`);

		if (obstaclePoints.length === 0) {
			// 无障碍物，直接填充用户多边形
			const outerPoints = ensureClockwise(userPoints);
			const outerSource = pointsToSourceArray(outerPoints);
			const complex = eda.pcb_MathPolygon.createComplexPolygon([outerSource] as any);
			if (!complex) {
				eda.sys_Message.showToastMessage('错误: 无法构建多边形', 'error', 3);
				return false;
			}
			const fill = await eda.pcb_PrimitiveFill.create(targetLayer as any, complex, '', undefined, 10, false);
			if (!fill) {
				eda.sys_Message.showToastMessage('错误: 无法创建填充', 'error', 3);
				return false;
			}
			fillCount++;
			sendStatus('done', { count: fillCount });
			return true;
		}

		// 步骤 3-6：裁剪→外扩→AABB→布尔差集
		const userRegionCW = ensureClockwise(userPoints);
		const results = await processObstaclePipeline(
			userRegionCW, obstaclePoints, obstacleRotations, obstacleNegateBisector, obstacleExtraGaps, gap,
		);

		if (results.length === 0) {
			eda.sys_Message.showToastMessage('挖洞后区域为空', 'warning', 3);
			return false;
		}

		eda.sys_Message.showToastMessage('正在创建填充...', 'info', 3);
		let created = 0;
		for (const result of results) {
			try {
				const outerSource = pointsToSourceArray(ensureClockwise(result.outer));
				const holeSources = result.holes.map(h => pointsToSourceArray(ensureCounterClockwise(h)));
				const complexPolyArray = [outerSource, ...holeSources];
				const fill = await createFillPrimitiveWithFix(targetLayer, complexPolyArray);
				if (fill) { created++; fillCount++; }
			}
			catch (e) {
				console.warn(TAG, 'Failed to create fill for sub-polygon:', e);
			}
		}

		if (created === 0) {
			eda.sys_Message.showToastMessage('错误: 无法创建填充', 'error', 3);
			return false;
		}

		console.warn(TAG, `Created ${created} fill(s), total: ${fillCount}`);
		const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
		console.warn(TAG, `[perf] 填充总耗时: ${totalTime}s`);
		eda.sys_Message.showToastMessage(`填充完成，耗时 ${totalTime}s`, 'info', 5);
		sendStatus('done', { count: fillCount });
		return true;
	}
	catch (e) {
		console.error(TAG, 'Failed to create fill:', e);
		eda.sys_Message.showToastMessage(`错误: ${e instanceof Error ? e.message : String(e)}`, 'error', 3);
		return false;
	}
}

async function processObstaclePipeline(
	regionCW: Point[],
	obstaclePoints: Point[][],
	obstacleRotations: number[],
	obstacleNegateBisector: boolean[],
	obstacleExtraGaps: number[],
	gap: number,
): Promise<{ outer: Point[]; holes: Point[][] }[]> {
	const t0 = Date.now();

	const metadata = obstaclePoints.map((_, i) => ({
		rotation: obstacleRotations[i],
		negateBisector: obstacleNegateBisector[i],
		extraGap: obstacleExtraGaps[i],
	}));
	const clippedWithMeta = await clipObstaclesToRegionWithMeta(
		obstaclePoints, metadata, regionCW,
		(done, total) => eda.sys_Message.showToastMessage(`正在裁剪障碍物... (${done}/${total})`, "info", 3),
	);
	const t1 = Date.now();
	console.warn(TAG, `[perf] Clip: ${obstaclePoints.length} → ${clippedWithMeta.length} in ${((t1 - t0) / 1000).toFixed(1)}s`);

	const offsetPoints = offsetObstacles(clippedWithMeta);
	const t2 = Date.now();
	console.warn(TAG, `[perf] Offset: ${clippedWithMeta.length} obstacles in ${((t2 - t1) / 1000).toFixed(1)}s`);

	const regionBB = calculateBoundingBox(regionCW);
	const maxExtraGap = Math.max(...clippedWithMeta.map(m => m.extraGap), gap);
	const regionBBExpanded = {
		minX: regionBB.minX - maxExtraGap,
		minY: regionBB.minY - maxExtraGap,
		maxX: regionBB.maxX + maxExtraGap,
		maxY: regionBB.maxY + maxExtraGap,
	};
	const aabbFiltered = offsetPoints.filter(pts => aabbIntersects(calculateBoundingBox(pts), regionBBExpanded));
	const t3 = Date.now();
	console.warn(TAG, `[perf] AABB filter: ${offsetPoints.length} → ${aabbFiltered.length} in ${((t3 - t2) / 1000).toFixed(1)}s`);

	// Boolean difference
	eda.sys_Message.showToastMessage("正在布尔运算...", "info", 3);
	const results = await subtractHolesFromRegionIncremental(
		regionCW, aabbFiltered,
		(done, total) => eda.sys_Message.showToastMessage(`正在布尔运算... (${done}/${total})`, "info", 3),
	);
	const t4 = Date.now();
	console.warn(TAG, `[perf] Boolean diff: ${aabbFiltered.length} holes → ${results.length} polys in ${((t4 - t3) / 1000).toFixed(1)}s`);
	console.warn(TAG, `[perf] Pipeline total: ${((t4 - t0) / 1000).toFixed(1)}s`);
	_g.__df_perf = { clip: t1 - t0, offset: t2 - t1, aabb: t3 - t2, boolDiff: t4 - t3, total: t4 - t0, obstaclesIn: obstaclePoints.length, clipped: clippedWithMeta.length, holes: aabbFiltered.length, results: results.length };

	return results;
}
/**
 * 自动检测目标丝印层
 * 规则：
 * 1. 如果有选中的图元，从图元层判断：顶层/顶层丝印 → 顶层丝印，底层/底层丝印 → 底层丝印
 * 2. 如果没有选中图元，默认顶层丝印层
 */
async function detectTargetSilkscreenLayer(): Promise<number> {
	try {
		// 尝试从选中的图元获取层信息
		const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		if (selectedIds && selectedIds.length > 0) {
			// 获取第一个选中图元的层信息
			const primitives = await eda.pcb_SelectControl.getAllSelectedPrimitives();
			if (primitives && primitives.length > 0) {
				const firstPrim = primitives[0];
				const layer = (firstPrim as any).getState_Layer?.();
				if (layer !== undefined) {
					console.warn(TAG, `Detected layer from selected primitive: ${layer}`);
					// 丝印层直接映射：3=TOP_SILKSCREEN, 4=BOTTOM_SILKSCREEN
					if (layer === LAYER_TOP_SILKSCREEN) {
						console.warn(TAG, 'Using TOP silkscreen (from selected primitive)');
						return LAYER_TOP_SILKSCREEN;
					}
					else if (layer === LAYER_BOTTOM_SILKSCREEN) {
						console.warn(TAG, 'Using BOTTOM silkscreen (from selected primitive)');
						return LAYER_BOTTOM_SILKSCREEN;
					}
					// 铜层 (1,2) 或其他层：默认顶层丝印，不跟随铜层
					console.warn(TAG, 'Non-silkscreen layer selected, defaulting to TOP silkscreen');
					return LAYER_TOP_SILKSCREEN;
				}
			}
		}

		// 默认顶层丝印
		console.warn(TAG, 'No selected primitive or unrecognized layer, using default: TOP silkscreen');
		return LAYER_TOP_SILKSCREEN;
	}
	catch (e) {
		console.warn(TAG, 'Failed to detect target layer, using default:', e);
		return LAYER_TOP_SILKSCREEN;
	}
}

/**
 * 主入口：打开控制面板 IFrame
 */
export async function drawDynamicFill(): Promise<void> {
	try {
		const docInfo = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		if (!docInfo || docInfo.documentType !== 3) {
			eda.sys_Dialog.showInformationMessage('请在PCB文档中使用此功能', '错误');
			return;
		}

		fillCount = 0;

		await eda.sys_IFrame.openIFrame(
			'/iframe/index.html',
			320,
			320,
			IFRAME_ID,
			{
				title: '动态丝印填充',
				minimizeButton: true,
				buttonCallbackFn: (button: string) => {
					if (button === 'close') {
						currentState = 'IDLE';
						currentPoints = [];
						deleteTempFill();
						cleanupListeners();
					}
				},
				onBeforeCloseCallFn: () => {
					currentState = 'IDLE';
					currentPoints = [];
					deleteTempFill();
					cleanupListeners();
					return true;
				},
			},
		);

		eda.sys_Timer.setIntervalTimer(POLL_TIMER_ID, 300, pollCommands);

		console.warn(TAG, 'Control panel opened, polling started');
	}
	catch (e) {
		console.error(TAG, 'Failed to open control panel:', e);
		eda.sys_Dialog.showInformationMessage(
			`打开控制面板失败: ${e instanceof Error ? e.message : String(e)}`,
			'错误',
		);
	}
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	console.warn(TAG, 'Extension activated');
}
