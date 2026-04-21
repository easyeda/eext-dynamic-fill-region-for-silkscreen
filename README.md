# 动态丝印填充扩展 / Dynamic Silkscreen Fill Region Extension

[中文](#中文) | [English](#english)

---

## 中文

### 功能特性

在PCB丝印层绘制多边形填充区域，自动挖除障碍物（焊盘、位号、过孔、文本、挖槽区域等）。

- 交互式绘制：点击画布拾取多边形顶点，Enter完成，Esc取消
- 自动收集6类障碍物：组件BBox、位号、游离焊盘、过孔、文本、挖槽/禁止区域
- 障碍物按间隙外扩，重叠区域自动合并（polyclip-ts 布尔并集）
- 多边形布尔差集生成最终填充（外轮廓CW + 洞CCW）
- 支持顶层丝印（Layer 3）和底层丝印（Layer 4）

### 使用方法

1. 在EasyEDA Pro中打开PCB文档
2. 选择菜单：**动态丝印填充** > **绘制动态填充...**
3. 输入间隙值，点击"开始绘制"
4. 在画布上点击拾取多边形顶点
5. 按 Enter 完成绘制，自动生成填充

### 安装

```bash
# 构建
npm install
npm run build

# 构建产物位于 build/dist/ 目录，通过 扩展 > 安装扩展 安装 .eext 文件
```

### 技术架构

#### 数据流

```
用户绘制多边形区域
  ↓
collectAllObstacles(): 收集所有障碍物
  ├─ 组件BBox + 位号 (componentData + designatorExtractor)
  ├─ 游离焊盘多边形 (componentData)
  ├─ 过孔圆形 (componentData)
  ├─ 文本BBox (componentData, 含Layer 1-4)
  ├─ 挖槽区域 (Fill on MULTI layer)
  └─ 禁止区域 (Region primitives)
  ↓
clipObstaclesToRegion(): 裁剪到用户绘制区域内
  ↓
offsetPolygonPoints(): 按间隙外扩（圆弧径向外扩）
  ↓
mergeOverlappingObstacles(): polyclip-ts 合并重叠区域
  ↓
buildUserPolygonComplex(): 构建复杂多边形
  外轮廓: 用户多边形 (CW)
  内洞: 合并后的障碍物 (CCW)
  ↓
createFillPrimitiveWithFix(): 创建填充图元
```

#### 核心模块

| 模块 | 说明 |
|------|------|
| `index.ts` | 扩展入口，UI交互，流程编排 |
| `componentData.ts` | 收集6类障碍物数据 |
| `designatorExtractor.ts` | 位号属性BBox（含旋转） |
| `polygonOffset.ts` | 多边形外扩（顶点法线 + 圆弧径向） |
| `polygonBoolean.ts` | polyclip-ts 布尔运算封装 |
| `booleanOperation.ts` | 构建复杂多边形并创建填充 |
| `polygonUtils.ts` | 多边形工具（L/ARC/CARC/C/R/CIRCLE解析） |

#### 支持的图元类型

| 障碍物来源 | API | 说明 |
|-----------|-----|------|
| 组件BBox | `pcb_PrimitiveComponent.getState_X/Y/Width/Height/Rotation` | 封装整体包围盒 |
| 位号 | `pcb_PrimitiveAttribute` + `getPrimitivesBBox` | Designator属性BBox |
| 游离焊盘 | `pcb_PrimitivePad` (primitiveType="Pad") | ELLIPSE/OVAL/RECT/NGON/POLYGON |
| 过孔 | `pcb_PrimitiveVia` | 圆形，使用外径 |
| 文本 | `pcb_PrimitiveString` + `getPrimitivesBBox` | Layer 1-4 丝印/铜层文本 |
| 挖槽区域 | `pcb_PrimitiveFill`(MULTI) | 矩形/圆形/多边形 |
| 禁止区域 | `pcb_PrimitiveRegion` | 约束区域 |

#### 坐标单位

PCB使用 **1mil** 作为单位（1mm ≈ 39.37 units）

### 许可证

Apache-2.0

---

## English

### Features

Draw polygon fill regions on PCB silkscreen layers with automatic obstacle avoidance.

- Interactive polygon drawing: click to add vertices, Enter to finish, Esc to cancel
- Auto-collects 6 obstacle types: component bbox, designators, standalone pads, vias, text, cutout/restriction regions
- Obstacles expanded by configurable gap, overlapping regions merged via polyclip-ts boolean union
- Boolean difference generates final fill (outer CW + holes CCW)
- Supports top silkscreen (Layer 3) and bottom silkscreen (Layer 4)

### Usage

1. Open a PCB document in EasyEDA Pro
2. Menu: **动态丝印填充** > **绘制动态填充...**
3. Enter gap value, click "开始绘制"
4. Click on canvas to pick polygon vertices
5. Press Enter to finish — fill is generated automatically

### Installation

```bash
npm install
npm run build
# Install .eext from build/dist/ via Extensions > Install Extension
```

### License

Apache-2.0
