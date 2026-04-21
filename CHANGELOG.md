# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-17

### Changed
- 重构挖洞流程：收集障碍物 → 裁剪到区域内 → 间隙外扩 → 合并重叠区域 → 布尔差集
- 障碍物合并使用 polyclip-ts 布尔并集，解决相邻障碍物间桥接填充问题
- 组件焊盘不再单独挖洞，统一使用组件BBox覆盖
- 游离焊盘过滤：仅处理 primitiveType="Pad"，忽略 ComponentPad
- 位号和文本使用 getPrimitivesBBox 获取精确BBox（含旋转）
- 圆形障碍物外扩改为径向外扩，保持圆润
- 圆弧状顶点外扩使用弧形公式 offset/cos(halfAngle)

### Fixed
- 挖槽区域圆形类型因 source.length<6 被跳过
- Layer 1 铜层游离文本未参与挖洞
- R token 中心坐标计算（top-left → center）
- 焊盘旋转单位（弧度→度数）
- 多边形偏移法线方向修正

## [1.0.0] - 2026-04-16

### Added
- 初始版本：动态丝印填充扩展
- 板框轮廓提取、封装解析、丝印图形提取
- 位号BBox、焊盘形状提取
- 多边形偏移算法、布尔运算构建复杂多边形
- 支持顶层和底层丝印
