# 当前实现逻辑梳理

## 整体流程

```
用户操作 → 收集障碍物 → 裁剪到区域 → 外扩 → AABB过滤 → Union合并洞 → 组装复杂多边形 → 创建填充
```

## 1. 入口

### handleFillAvoid (选丝印填充避让)
- 获取选中图元，检测是否是丝印层填充区域
- 提取填充几何 → collectAllObstacles → processObstaclePipeline
- 删除原填充 → 创建新填充

### processPolygonFill (绘制填充)
- 用户绘制多边形 → collectAllObstacles → processObstaclePipeline
- 创建填充

## 2. collectAllObstacles (src/index.ts)

并行获取所有障碍物数据 (Promise.all):
- components → getComponentObstacles (位号 + 封装BBox)
- standalonePads → getStandalonePadPolygons (过滤封装内焊盘)
- componentPads → getComponentPadPolygons (仅当不勾选封装时)
- vias → getViaPolygons (过滤封装内过孔)
- copperTexts/silkTexts → getSilkscreenTextBoxesWithRotation
- cutouts → getCutoutRegionPolygons
- silkLines/copperLines → getLinePolygons
- copperTracks → getTrackPolygons (含圆弧导线)
- regions → getRegionPolygons

### 封装内焊盘/过孔过滤逻辑
- 收集所有组件的 getPrimitivesBBox 作为 compBBoxes
- 焊盘/过孔的中心点在 compBBoxes 内 且 勾选了封装 → 跳过（由封装BBox统一覆盖）

## 3. processObstaclePipeline (src/index.ts)

返回类型: `{ outers: Point[][]; holes: Point[][] }`

### Step 1: Clip (裁剪)
- `clipObstaclesToRegionWithMeta()` (polygonBoolean.ts)
- AABB 预筛：障碍物 AABB 不与 region AABB 相交 → 跳过
- AABB 全包含：障碍物完全在 region 内 → 直接保留，跳过 polyclip intersection
- 边界相交：polyclip-ts `intersection` 精确裁剪
- 每50个让出主线程

### Step 2: Offset (外扩)
- `offsetObstacles()` (polygonOffset.ts)
- ensureCounterClockwise → offsetPolygonPoints
- rotation > 0 且 extraGap > 0 时做 rotate-back → offset → rotate-forward

### Step 3: AABB Filter
- 计算 regionBB 扩展 maxExtraGap
- 过滤掉 AABB 不相交的洞

### Step 4: Union All Holes (合并洞)
- `unionAllHoles()` (polygonBoolean.ts)
- 先尝试单次 `union(all)` — 一次 sweep-line
- 失败则分批递归：每200个一组 union，结果再 union，直到收敛
- 保证输出无重叠

### Step 5: 返回
- outers: [regionCW] (原始区域)
- holes: 合并后的洞列表

## 4. 组装复杂多边形 (src/index.ts 调用方)

```typescript
for (const outer of outers) {
    const outerSource = pointsToSourceArray(ensureClockwise(outer));      // 负签名面积
    const holeSources = holes.map(h => pointsToSourceArray(ensureCounterClockwise(h))); // 正签名面积
    const complexPolyArray = [outerSource, ...holeSources];
    createFillPrimitiveWithFix(layer, complexPolyArray);
}
```

### 绕向规则 (Y-down 坐标系)
- 外框: `ensureClockwise` → 负签名面积 → 视觉顺时针
- 内洞: `ensureCounterClockwise` → 正签名面积 → 视觉逆时针
- EasyEDA nonzero fill-rule: 外框CW + 洞CCW = 洞区域 winding=0 不填充

## 5. 关键文件

### src/index.ts
- drawDynamicFill: 主入口
- handleFillAvoid: 选丝印填充避让
- processPolygonFill: 绘制填充
- collectAllObstacles: 收集障碍物
- processObstaclePipeline: 处理管线

### src/core/polygonBoolean.ts
- clipObstaclesToRegionWithMeta: 裁剪+元数据
- unionAllHoles: 合并所有洞（单次/分批递归）
- mergeOverlappingObstacles: 旧版分组合并（可能未使用）

### src/core/polygonOffset.ts
- offsetPolygonPoints: 顶点法线外扩
- offsetObstacles: 批量外扩
- tryRadialOffset: 圆形径向外扩

### src/core/obstacleCollector.ts
- getAllComponents, getComponentObstacles
- getStandalonePadPolygons, getComponentPadPolygons
- getViaPolygons
- getSilkscreenTextBoxesWithRotation (并行bbox)
- getLinePolygons (支持 L/ARC/CARC/R/CIRCLE)
- getTrackPolygons (直线+圆弧导线)
- getCutoutRegionPolygons, getRegionPolygons

### src/utils/polygonUtils.ts
- sourceArrayToPoints: 解析 L/ARC/CARC/C/R/CIRCLE
- calculateSignedArea, ensureClockwise, ensureCounterClockwise
- createRectanglePolygon, createCirclePolygon, createPadPolygon
- calculateBoundingBox, aabbIntersects

### src/core/booleanOperation.ts
- createFillPrimitiveWithFix: 创建填充（带fallback）

### iframe/index.html
- 弹窗UI: 间隙、层、避让对象勾选（含封装选项）

## 6. 性能热点 (5545障碍物场景)

| 步骤 | 耗时 |
|------|------|
| Collect | ~15s (文本bbox并行获取) |
| Clip | ~0.01s (AABB全包含跳过) |
| Offset | ~0.15s |
| AABB filter | ~0.01s |
| Union holes | ~20s (polyclip union) |
| 创建填充 | <1s |
| **总计** | **~36s** |

## 7. 已知问题

- polyclip-ts union 对大量多边形可能失败，需要分批递归
- 绕向在 Y-down 坐标系下容易搞混
- R 格式的旋转中心是起始点 (rx,ry)，height 向上 (-Y)
- 文本 bbox 是 AABB，需要反算原始尺寸再旋转

---

## 8. unionAllHoles 详细逻辑 (polygonBoolean.ts)

### 目的
消除重叠洞。createComplexPolygon 用 nonzero fill-rule，两个 CCW 洞重叠区域 winding=+1-1-1=-1（非零）会显示为填充而不是洞。

### 输入
- `holes: Point[][]` — 外扩后、AABB过滤后、裁剪后的所有洞多边形

### 输出
- `Point[][]` — 无重叠的洞多边形列表

### 算法步骤

#### Step 1: AABB 计算 + 容差扩展
```typescript
const EPS = 2; // 2mil 容差
const bboxes = holes.map(pts => {
    const bb = calculateBoundingBox(pts);
    return { minX: bb.minX - EPS, minY: bb.minY - EPS, maxX: bb.maxX + EPS, maxY: bb.maxY + EPS };
});
```
每个洞的 AABB 向外扩展 2mil，确保边缘刚好相切的洞也能被检测为重叠。

#### Step 2: Sweep-line AABB 重叠检测
```
事件列表: 每个洞生成两个事件 (minX=start, maxX=end)
按 X 排序，start 优先于 end

扫描线从左到右:
  遇到 start 事件:
    与 active 集合中所有洞做 AABB 相交检测
    相交的洞用 union-find 合并到同一组
    加入 active 集合
  遇到 end 事件:
    从 active 集合移除
```

复杂度: O(N log N) 排序 + O(N * K) 扫描（K = 平均 active 集合大小）

**问题**: sweep-line 只在 X 轴上扫描，active 集合中的洞仍然需要逐个做 AABB 检测。当大量洞在 X 轴上重叠时（比如一列过孔），active 集合会很大。

#### Step 3: Union-Find 分组
```
parent[i] = i (初始每个洞是自己的根)
find(x): 路径压缩查找根
unite(a, b): 合并两个组

分组后: groups = Map<root, indices[]>
```

#### Step 4: 每组 Union
```
对每个组:
  组大小 = 1 → 直接透传，不需要 union
  组大小 > 1 → 尝试 polyclip-ts union:
    
    尝试1: 变参 union(geoms[0], ...geoms.slice(1))
      成功 → 提取结果多边形的外环
      失败 → 进入 fallback
    
    Fallback: 逐个累积 union
      acc = holes[0]
      for k = 1..N:
        try: acc = union(acc, holes[k])
        catch: 
          把 acc 当前结果加入 merged
          acc = holes[k] (重新开始)
      最后把 acc 加入 merged
```

### 关键问题分析

#### 问题1: AABB 容差不够
外扩后两个洞可能在几何上相交但 AABB 刚好不重叠（浮点精度）。
当前容差: 2mil。

#### 问题2: polyclip-ts union 精度
polyclip-ts 使用 Martinez-Rueda-Feito 算法，对以下情况可能失败:
- 共线边（两个多边形共享一条边）
- 极小面积的交叉区域
- 大量顶点的复杂多边形

失败时 catch 块的 fallback 逐个累积 union，但如果某个洞导致 union 失败，它会被单独保留（未合并），导致与其他洞重叠。

#### 问题3: 只提取外环
```typescript
for (const poly of current) {
    if (poly.length > 0 && poly[0].length >= 4) {
        merged.push(ringToPoints(poly[0])); // 只取 poly[0] = 外环
    }
}
```
union 结果可能包含内环（洞中洞），当前代码忽略了内环。这在大多数情况下是正确的（障碍物是实心的），但如果两个环形障碍物 union，内部的洞会丢失。

#### 问题4: 过孔和线条的特殊性
- 过孔是圆形（16段近似），外扩后仍是圆形
- 线条胶囊是半圆端帽 + 矩形体
- 这些形状的顶点密度不同，polyclip-ts 在处理圆弧近似多边形时可能产生精度问题
- 特别是当圆形过孔刚好与矩形封装 BBox 的边相切时

### 当前流程图

```
输入: 3050 个洞 (外扩后)
  ↓
AABB 扩展 2mil
  ↓
Sweep-line 分组
  ↓ 
例如: 1800 个独立组(size=1) + 200 个重叠组(size=2~50)
  ↓
独立组: 直接透传 (1800个)
重叠组: polyclip union (200组)
  ↓
成功: 合并为更少的多边形
失败: fallback 逐个 union 或原样保留
  ↓
输出: ~1400 个无重叠洞
  ↓
传入 createComplexPolygon([outer, ...holes])
```

### 可能的改进方向

1. **增大 AABB 容差** — 但太大会把不相关的洞分到同一组，增加 union 计算量
2. **对 union 失败的组做 difference 替代** — 用 difference(bigBBox, hole1, hole2...) 间接合并
3. **简化圆形多边形** — 减少过孔的顶点数（16→12），降低 polyclip 精度问题
4. **对 union 结果做二次验证** — 检查输出是否仍有重叠，重叠的再次 union
5. **换用更稳定的布尔运算库** — 如 clipper2（C++ WASM 版本）
