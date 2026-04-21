/**
 * 动态丝印填充扩展
 * Dynamic Silkscreen Fill Region Extension
 *
 * 交互式绘制多边形区域，自动布尔运算去除障碍物（焊盘、位号等）
 */

import type { Point } from './utils/polygonUtils';
import { createFillPrimitiveWithFix } from './core/booleanOperation';
import { getAllComponents, getComponentObstacles, getCutoutRegionPolygons, getLinePolygons, getRegionPolygons, getSilkscreenTextBoxes, getSilkscreenTextBoxesWithRotation, getStandalonePadPolygons, getTrackPolygons, getViaPolygons } from './core/componentData';
import { mergeOverlappingObstacles, subtractHolesFromRegion } from './core/polygonBoolean';
import { offsetPolygonPoints } from './core/polygonOffset';
import { LAYER_BOTTOM_COPPER, LAYER_BOTTOM_SILKSCREEN, LAYER_TOP_COPPER, LAYER_TOP_SILKSCREEN } from './utils/constants';
import { ensureClockwise, ensureCounterClockwise, pointsToSourceArray, sourceArrayToPoints } from './utils/polygonUtils';

const TAG = '[DynamicFill]';

let currentState: 'IDLE' | 'DRAWING' = 'IDLE';

let currentGap: number = 10;
interface ObstacleOptions {
	vias: boolean;
	pads: boolean;
	cutouts: boolean;
	textCopper: boolean;
	textSilk: boolean;
	linesSilk: boolean;
	linesCopper: boolean;
	tracksCopper: boolean;
}

let currentOptions: ObstacleOptions = { vias: true, pads: true, cutouts: true, textCopper: true, textSilk: true, linesSilk: true, linesCopper: true, tracksCopper: true };
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
			eda.sys_Message.showFollowMouseTip('已拾取' + currentPoints.length + '个点，可点击"完成绘制"结束');

			console.warn(TAG, `Point #${currentPoints.length}: (${pos.x}, ${pos.y})`);
		sendStatus('points', { count: currentPoints.length });
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
								await addPointAtCursor();
							}
						},
					);
					console.warn(TAG, 'Mouse event listener registered');
				}
				catch (e) {
					console.warn(TAG, 'Failed to register mouse listener:', e);
				}

				// 显示 tooltip
				eda.sys_Message.showFollowMouseTip('请左键点击绘制区域');
			}
			else if (cmd.type === 'stop') {
				console.warn(TAG, 'Stop command received');

				currentState = 'IDLE';
				currentPoints = [];
				await deleteTempFill();
				cleanupListeners();
				eda.sys_Message.removeFollowMouseTip('请左键点击绘制区域');
			}
			else if (cmd.type === 'finish') {
				console.warn(TAG, 'Finish polygon command received');
				if (currentState === 'DRAWING') {
					const success = await finishCurrentPolygon();
					if (success) {
						currentState = 'IDLE';
						cleanupListeners();
						eda.sys_Message.removeFollowMouseTip('请左键点击绘制区域');
					}
				}
			}
		}
	}
	catch (e) {
		console.warn(TAG, 'Poll error:', e);
	}
}

/**
 * 完成当前多边形：创建临时填充 → 布尔运算 → 删除临时填充 → 写入最终填充
 * @returns true if fill was created successfully
 */
async function finishCurrentPolygon(): Promise<boolean> {
	if (currentPoints.length < 3) {
		eda.sys_Message.showFollowMouseTip('至少需要3个点才能完成多边形', 3000);
		return false;
	}

	const points = [...currentPoints];
	currentPoints = [];

	eda.sys_Message.showFollowMouseTip('正在收集障碍物...');

	try {
		// 1. 创建临时填充（用户绘制的原始多边形）
		const outerPoints = ensureClockwise(points);
		const outerSource = pointsToSourceArray(outerPoints);
		const tempComplex = eda.pcb_MathPolygon.createComplexPolygon([outerSource] as any);
		if (!tempComplex) {
			eda.sys_Message.showFollowMouseTip('错误: 无法构建多边形', 3000);
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
			eda.sys_Message.showFollowMouseTip('错误: 无法创建绘制区域', 3000);
			return false;
		}

		tempFillId = tempFill.getState_PrimitiveId();
		console.warn(TAG, `Temp fill created: ${tempFillId}`);

		// 2. 收集障碍物并执行布尔运算
		const success = await processPolygonFill(points, currentGap);

		// 3. 删除临时填充
		await deleteTempFill();

		if (!success) {
			eda.sys_Message.showFollowMouseTip('创建失败，请重试', 3000);
		}
		return success;
	}
	catch (e) {
		console.error(TAG, 'Failed to finish polygon:', e);
		await deleteTempFill();
		eda.sys_Message.showFollowMouseTip(`错误: ${e instanceof Error ? e.message : String(e)}`, 3000);
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
	let compDesignator = 0; let compBBox = 0;

	const components = await getAllComponents();
	for (const comp of components) {
		try {
			const obstacles = await getComponentObstacles(comp, layer);
			const compRotation = comp.getState_Rotation?.() ?? 0;
			if (obstacles.designatorBox) {
				allObstacles.push({ polygon: obstacles.designatorBox, rotation: compRotation, negateBisector: false });
				compDesignator++;
			}
			if (obstacles.componentBBox) {
				allObstacles.push({ polygon: obstacles.componentBBox, rotation: compRotation, negateBisector: false });
				compBBox++;
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get component obstacles:', e);
		}
	}
	console.warn(TAG, `Components: ${components.length} comps, ${compDesignator} designators, ${compBBox} bboxes`);

	let standalonePadCount = 0;
	if (options.pads) {
		try {
			const standalonePads = await getStandalonePadPolygons(layer);
			standalonePadCount = standalonePads.length;
			for (const pad of standalonePads) {
				allObstacles.push({ polygon: pad.polygon, rotation: 0, negateBisector: false });
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get standalone pads:', e);
		}
	}
	console.warn(TAG, `Standalone pads: ${standalonePadCount}`);

	// 过孔
	let viaCount = 0;
	if (options.vias) {
		try {
			const vias = await getViaPolygons();
			viaCount = vias.length;
			for (const via of vias) {
				allObstacles.push({ polygon: via, rotation: 0, negateBisector: false });
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get via polygons:', e);
		}
	}
	console.warn(TAG, `Vias: ${viaCount}`);

	let textCount = 0;
	// 铜层文本
	if (options.textCopper) {
		try {
			const copperLayer = layer === LAYER_BOTTOM_SILKSCREEN ? LAYER_BOTTOM_COPPER : LAYER_TOP_COPPER;
			const textData = await getSilkscreenTextBoxesWithRotation(copperLayer, gap);
			for (const t of textData) {
				allObstacles.push({ polygon: t.polygon, rotation: 0, negateBisector: false, extraGap: 0 });
				textCount++;
				console.warn(TAG, `  Copper text: rot=${t.rotation}, pts=${t.polygon.length}`);
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get copper text boxes:', e);
		}
	}
	// 丝印层文本
	if (options.textSilk) {
		try {
			const textData = await getSilkscreenTextBoxesWithRotation(layer, gap);
			for (const t of textData) {
				allObstacles.push({ polygon: t.polygon, rotation: 0, negateBisector: false, extraGap: 0 });
				textCount++;
				console.warn(TAG, `  Silk text: rot=${t.rotation}, pts=${t.polygon.length}`);
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get silkscreen text boxes:', e);
		}
	}
	console.warn(TAG, `Text boxes: ${textCount}`);

	// 挖槽区域（Fill on MULTI layer）
	let cutoutCount = 0;
	if (options.cutouts) {
		try {
			const cutouts = await getCutoutRegionPolygons();
			cutoutCount = cutouts.length;
			for (const cutout of cutouts) {
				allObstacles.push({ polygon: cutout, rotation: 0, negateBisector: false });
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get cutout regions:', e);
		}
	}
	console.warn(TAG, `Cutout regions: ${cutoutCount}`);

	// 丝印层线条
	let silkLineCount = 0;
	if (options.linesSilk) {
		try {
			const silkLines = await getLinePolygons(layer);
			silkLineCount = silkLines.length;
			for (const line of silkLines) {
				allObstacles.push({ polygon: line, rotation: 0, negateBisector: false });
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get silkscreen lines:', e);
		}
	}
	console.warn(TAG, `Silkscreen lines: ${silkLineCount}`);

	// 铜层线条（Polyline on copper layer）
	let copperLineCount = 0;
	if (options.linesCopper) {
		try {
			const copperLayer = layer === LAYER_BOTTOM_SILKSCREEN ? LAYER_BOTTOM_COPPER : LAYER_TOP_COPPER;
			const copperLines = await getLinePolygons(copperLayer);
			copperLineCount = copperLines.length;
			for (const line of copperLines) {
				allObstacles.push({ polygon: line, rotation: 0, negateBisector: false });
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get copper lines:', e);
		}
	}
	console.warn(TAG, `Copper lines: ${copperLineCount}`);

	// 铜层导线
	let copperTrackCount = 0;
	if (options.tracksCopper) {
		try {
			const copperLayer = layer === LAYER_BOTTOM_SILKSCREEN ? LAYER_BOTTOM_COPPER : LAYER_TOP_COPPER;
			const copperTracks = await getTrackPolygons(copperLayer);
			copperTrackCount = copperTracks.length;
			for (const track of copperTracks) {
				allObstacles.push({ polygon: track, rotation: 0, negateBisector: false });
			}
		}
		catch (e) {
			console.warn(TAG, 'Failed to get copper tracks:', e);
		}
	}
	console.warn(TAG, `Copper tracks: ${copperTrackCount}`);

	// 禁止区域/约束区域（Region primitives）
	let regionCount = 0;
	try {
		const regions = await getRegionPolygons();
		regionCount = regions.length;
		for (const region of regions) {
			allObstacles.push({ polygon: region, rotation: 0, negateBisector: false });
		}
	}
	catch (e) {
		console.warn(TAG, 'Failed to get region polygons:', e);
	}
	console.warn(TAG, `Region primitives: ${regionCount}`);

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
	if (userPoints.length < 3) {
		eda.sys_Message.showFollowMouseTip('错误: 至少需要3个点', 3000);
		return false;
	}

	try {
		// 步骤 1-2：收集障碍物
		eda.sys_Message.showFollowMouseTip('正在收集障碍物...');
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
				eda.sys_Message.showFollowMouseTip('错误: 无法构建多边形', 3000);
				return false;
			}
			const fill = await eda.pcb_PrimitiveFill.create(targetLayer as any, complex, '', undefined, 10, false);
			if (!fill) {
				eda.sys_Message.showFollowMouseTip('错误: 无法创建填充', 3000);
				return false;
			}
			fillCount++;
			eda.sys_Message.removeFollowMouseTip();
			sendStatus('done', { count: fillCount });
			return true;
		}

		// 步骤 3-4：根据间隙外扩（确保逆时针方向，外扩算法法向量朝外）
		// 对于旋转的障碍物（文本、封装），使用 rotate-offset-rotate-back 方法
		console.warn(TAG, `Offset step: gap=${gap}, obstacleCount=${obstaclePoints.length}`);
		const offsetPoints: Point[][] = [];
		for (let i = 0; i < obstaclePoints.length; i++) {
			const pts = obstaclePoints[i];
			const rotation = obstacleRotations[i];
			const negateBisector = obstacleNegateBisector[i];
			const extraGap = obstacleExtraGaps[i];
			const ccwPts = ensureCounterClockwise(pts);
			if (extraGap > 0 && Math.abs(rotation) > 0.01) {
				// Rotated obstacle: use rotate-offset-rotate-back
				const offset = offsetPolygonPoints(ccwPts, extraGap, rotation, negateBisector);
				offsetPoints.push(offset);
				if (i < 3) console.warn(TAG, `  Obstacle #${i}: rotated=${rotation.toFixed(1)}, negate=${negateBisector}, extraGap=${extraGap}, offset applied`);
			}
			else {
				// Non-rotated, no gap, or extraGap=0: direct offset (or no-op if extraGap=0)
				const offset = offsetPolygonPoints(ccwPts, extraGap, 0, negateBisector);
				offsetPoints.push(offset);
				if (i < 3) {
					const origY = pts[0]?.y ?? 0;
					const offY = offset[0]?.y ?? 0;
					const dy = offY - origY;
					console.warn(TAG, `  Obstacle #${i}: extraGap=${extraGap}, rotation=${rotation}, negate=${negateBisector}, origY=${origY.toFixed(2)}, offsetY=${offY.toFixed(2)}, deltaY=${dy.toFixed(2)}`);
				}
			}
		}

		// 步骤 5：跳过合并，直接进行布尔差运算（polyclip-ts 可以一次处理多个洞）
		console.warn(TAG, `Skipping merge, using ${offsetPoints.length} holes directly`);
		for (let i = 0; i < offsetPoints.length; i++) {
			const pts = offsetPoints[i];
			const xs = pts.map(p => p.x);
			const ys = pts.map(p => p.y);
			const w = Math.max(...xs) - Math.min(...xs);
			const h = Math.max(...ys) - Math.min(...ys);
			const orig = obstaclePoints[i];
			const oxs = orig.map(p => p.x);
			const oys = orig.map(p => p.y);
			const ow = Math.max(...oxs) - Math.min(...oxs);
			const oh = Math.max(...oys) - Math.min(...oys);
			if (i < 10) console.warn(TAG, `  Hole #${i}: origAABB=${ow.toFixed(0)}x${oh.toFixed(0)} offsetAABB=${w.toFixed(0)}x${h.toFixed(0)}`);
		}

		// 步骤 6：布尔差集
		eda.sys_Message.showFollowMouseTip('正在构建多边形...');
		const userRegion = ensureClockwise(userPoints);
		const results = subtractHolesFromRegion(userRegion, offsetPoints);

		if (results.length === 0) {
			eda.sys_Message.showFollowMouseTip('挖洞后区域为空', 3000);
			return false;
		}

		console.warn(TAG, `Difference result: ${results.length} polygon(s)`);

		// 将每个结果多边形转为 complex polygon 格式并创建填充
		eda.sys_Message.showFollowMouseTip('正在创建填充...');
		let created = 0;

		for (const result of results) {
			try {
				const outerSource = pointsToSourceArray(ensureClockwise(result.outer));
				const holeSources = result.holes.map(h => pointsToSourceArray(ensureCounterClockwise(h)));
				const complexPolyArray = [outerSource, ...holeSources];

				const fill = await createFillPrimitiveWithFix(targetLayer, complexPolyArray);
				if (fill) {
					created++;
					fillCount++;
				}
			}
			catch (e) {
				console.warn(TAG, 'Failed to create fill for sub-polygon:', e);
			}
		}

		if (created === 0) {
			eda.sys_Message.showFollowMouseTip('错误: 无法创建填充', 3000);
			return false;
		}

		console.warn(TAG, `Created ${created} fill(s), total: ${fillCount}`);
		eda.sys_Message.removeFollowMouseTip();
		sendStatus('done', { count: fillCount });
		return true;
	}
	catch (e) {
		console.error(TAG, 'Failed to create fill:', e);
		eda.sys_Message.showFollowMouseTip(`错误: ${e instanceof Error ? e.message : String(e)}`, 3000);
		return false;
	}
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
			450,
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
						eda.sys_Message.removeFollowMouseTip('请左键点击绘制区域');
					}
				},
				onBeforeCloseCallFn: () => {
					currentState = 'IDLE';
					currentPoints = [];
					deleteTempFill();
					cleanupListeners();
					eda.sys_Message.removeFollowMouseTip('点击画布拾取点 | Enter完成 | Esc取消');
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
