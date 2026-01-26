# ComfyUI-Prompt-Presets

一个为 ComfyUI 设计的提示词预设管理插件，提供悬浮菜单快速添加专业级预设，并支持智能优先级排序。

![ComfyUI](https://img.shields.io/badge/ComfyUI-Plugin-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## ✨ 功能特性

### 🎯 核心功能

- **悬浮预设菜单** - 右下角悬浮按钮，鼠标悬停展开分类菜单
- **一键添加预设** - 点击预设即可追加到选中节点的提示词输入框
- **预设预览** - 悬停显示预设效果图片/视频
- **智能排序** - 自动按优先级（Tier 1-7）重排提示词顺序
- **自定义预设** - 支持添加和管理用户自定义预设
- **黑白名单** - 配置识别/排除特定 widget 名称

### 📂 预设分类

| 优先级 | 分类 | 说明 |
|-------|------|------|
| Tier 1 | 运镜动作 (视频) | 推进、拉远、摇摄、环绕等 |
| Tier 2 | 景别与构图 | 全景、特写、三分法、留白等 |
| Tier 3 | 镜头视角与焦距 | 航拍、仰拍、鱼眼、长焦等 |
| Tier 4 | **用户输入** | 您的主体描述 |
| Tier 5 | 光影与氛围 | 体积光、伦勃朗光、霓虹光等 |
| Tier 6 | 风格与调色 | 赛博朋克、吉卜力、青橙色调等 |
| Tier 7 | 器材与特效 | ARRI、胶片质感、故障风等 |

## 🚀 安装

### 方法一：手动安装

```bash
cd ComfyUI/custom_nodes/
git clone https://github.com/iOrange-ZR/ComfyUI-Prompt-Presets.git
```

### 方法二：复制文件夹

将整个 `ComfyUI-Prompt-Presets` 文件夹复制到 `ComfyUI/custom_nodes/` 目录下。

安装后重启 ComfyUI 即可使用。

## 📖 使用方法

### 基本操作

1. **选中节点** - 点击画布中有提示词输入框的节点
2. **打开菜单** - 鼠标悬停在右下角 📝 按钮上
3. **选择预设** - 依次进入分类 → 点击要添加的预设
4. **查看结果** - 预设会自动追加到选中节点，并按优先级排序

### 预览功能

- 悬停在预设项上可查看效果预览图
- 有预览的预设会显示 🖼️ 图标

### 管理已添加

- 点击菜单中的「管理已添加」可查看当前 prompt 中的预设
- 支持删除单个预设或编辑内容

### 自定义预设

- 点击菜单中的「✨ 自定义」进入自定义预设管理
- 支持添加、编辑、删除自定义预设

### 设置

- 点击菜单中的「⚙️ 设置」打开配置面板
- **白名单**：添加需要识别的 widget 名称
- **黑名单**：排除不需要识别的 widget 名称

## 🔧 智能排序说明

当您添加多个不同分类的预设时，插件会自动按优先级重新排列：

```
添加顺序：赛博朋克 → 环绕运镜 → 特写镜头
自动排序：【环绕运镜】, 【特写镜头】, 用户输入, 【赛博朋克】
           ↑ Tier 1      ↑ Tier 2           ↑ Tier 6
```

这确保 AI 在生成时优先处理运镜动作和构图，避免因 prompt 过长导致遗漏关键特征。

## 📁 文件结构

```
ComfyUI-Prompt-Presets/
├── __init__.py          # 后端入口，API 路由
├── prompt_presets.json  # 预设数据（含 tier 优先级）
├── README.md            # 本文档
├── previews/            # 预设预览图片/视频
│   ├── Cyberpunk.jpg
│   └── ...
└── web/
    └── prompt_presets.js  # 前端 UI 和逻辑
```

## 🎨 添加预览图片

1. 将图片放入 `previews/` 文件夹
2. 在 `prompt_presets.json` 中为对应预设添加 `"preview": "文件名.jpg"`

支持格式：`jpg`, `png`, `webp`, `mp4`, `webm`

## ⚙️ 自定义预设数据

编辑 `prompt_presets.json` 可添加/修改预设：

```json
{
    "category": "分类名称",
    "category_en": "Category Name",
    "tier": 6,
    "presets": [
        {
            "sub_category": "预设名称 (English)",
            "prompt_value": "prompt text here",
            "preview": "preview_image.jpg"
        }
    ]
}
```

## 📝 更新日志

### v1.0.0
- 初始版本发布
- 悬浮菜单 + 级联分类
- 自定义预设管理
- 预设预览功能
- 智能优先级排序（Tier 1-7）
- 白名单/黑名单配置
- 多输入框选择支持

## 📄 License

MIT License
