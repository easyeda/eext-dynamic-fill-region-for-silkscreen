# 动态丝印填充扩展 PRD

## 1. 概念与愿景

在PCB丝印层快速生成带有障碍物避让的填充区域。用户通过交互式绘制多边形或选择已有填充，一键完成复杂避让处理，大幅提升丝印填充效率。

## 2. 用户场景

- **场景一**：设计PCB后需要在大面积区域绘制丝印填充，手动避让所有焊盘、位号、过孔等工作繁琐易错
- **场景二**：已有丝印填充区域需要调整避让参数，传统方式需删除重建

## 3. 功能列表

### 3.1 交互式绘制填充
- 用户设置间隙值（mil）和目标层（顶层/底层丝印）
- 点击画布拾取多边形顶点，Enter完成，Esc取消
- 自动收集6类障碍物并避让
- 生成最终填充图元

### 3.2 填充避让
- 用户选中已有丝印层填充区域
- 点击"根据已有填充避让"按钮
- 自动提取填充几何，执行避让，替换原填充

### 3.3 障碍物类型
| 类型 | 来源 | 说明 |
|------|------|------|
| 组件BBox | `pcb_PrimitiveComponent` | 封装整体包围盒 |
| 位号 | `pcb_PrimitiveAttribute` + `getPrimitivesBBox` | 含旋转角度 |
| 游离焊盘 | `pcb_PrimitivePad` (primitiveType="Pad") | 独立焊盘 |
| 过孔 | `pcb_PrimitiveVia` | 圆形，使用外径 |
| 文本 | `pcb_PrimitiveString` + `getPrimitivesBBox` | Layer 1-4 |
| 挖槽/禁止区域 | `pcb_PrimitiveFill`(MULTI) / `pcb_PrimitiveRegion` | - |

## 4. 技术设计

### 4.1 核心流程

```
用户绘制多边形 ──→ 收集障碍物 ──→ 裁剪到区域内
                                     ↓
                              障碍物外扩(间隙)
                                     ↓
                              合并重叠区域
                                     ↓
                              布尔差集运算
                                     ↓
                              创建填充图元
```

### 4.2 关键算法

**多边形外扩**
- 顶点法线方向外扩
- 圆弧状顶点使用弧形公式 `offset / cos(halfAngle)`
- 旋转障碍物使用 rotate → offset → rotate-back

**布尔运算**
- 障碍物合并：polyclip-ts union
- 最终填充：polyclip-ts difference

**填充区域检测**
- `getAllSelectedPrimitives()` 返回选中图元
- 检测 `primitiveType === 'Region'` 且 `regionName === 'Fill Region'`
- 从 `complexPolygon.polygon` 提取几何数据

### 4.3 模块架构

| 模块 | 职责 |
|------|------|
| `index.ts` | 入口、UI交互、命令调度 |
| `componentData.ts` | 收集6类障碍物数据 |
| `designatorExtractor.ts` | 位号BBox提取(含旋转) |
| `polygonOffset.ts` | 多边形外扩算法 |
| `polygonBoolean.ts` | polyclip-ts布尔运算封装 |
| `booleanOperation.ts` | 构建复杂多边形 |
| `polygonUtils.ts` | 多边形格式解析(L/ARC/CIRCLE/R等) |

### 4.4 依赖

- **polyclip-ts** (MIT): 多边形布尔运算

## 5. API 使用

```typescript
// 获取选中图元
eda.pcb_SelectControl.getAllSelectedPrimitives()

// 填充区域属性
prim.primitiveType === 'Region'
prim.regionName === 'Fill Region'
prim.layer === 3 (顶层丝印) || 4 (底层丝印)
prim.complexPolygon.polygon  // TPCB_PolygonSourceArray

// 删除填充
eda.pcb_PrimitiveFill.delete(fillId)

// 创建填充
eda.pcb_PrimitiveFill.create(layer, complexPolygon, net, fillMode, lineWidth, primitiveLock)
```

## 6. UI 设计

- **间隙输入**：数字输入框，单位mil
- **层选择**：单选按钮（顶层丝印/底层丝印）
- **避让对象**：多选复选框（过孔、游离焊盘、挖槽区域、丝印文本、丝印线条、铜层文本、铜层线条、铜层导线）
- **操作按钮**：开始绘制 / 完成绘制 / 根据已有填充避让
- **快捷键**：Enter完成绘制，Esc取消绘制

## 7. 版本历史

- v1.2.0 (2026-04-22): 正式发布，支持交互式绘制和填充避让两种模式
