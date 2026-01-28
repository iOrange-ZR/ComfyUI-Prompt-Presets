"""
ComfyUI-Prompt-Presets
独立的提示词预设管理插件

功能：
- 悬浮按钮，悬停显示预设分类菜单
- 一键添加预设到任何有 prompt 输入框的节点
- 用户自定义预设（localStorage 存储）
- 管理已添加的预设（编辑、删除）
"""

import os
import json
import server
from aiohttp import web

# 获取当前目录
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))

# 加载预设数据的 API
@server.PromptServer.instance.routes.get("/prompt_presets/data")
async def get_prompt_presets(request):
    presets_path = os.path.join(CURRENT_DIR, "prompt_presets.json")
    try:
        with open(presets_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return web.json_response(data)
    except Exception as e:
        print(f"[PromptPresets] Error loading presets: {e}")
        return web.json_response([])

# 预览文件服务 API - 使用正则匹配完整文件名（包括扩展名）
@server.PromptServer.instance.routes.get("/prompt_presets/preview/{filename:.+}")
async def get_preview_file(request):
    from urllib.parse import unquote
    
    raw_filename = request.match_info.get('filename', '')
    # URL 解码文件名（处理空格等特殊字符）
    filename = unquote(raw_filename)
    
    # 调试日志
    print(f"[PromptPresets] Preview request: raw='{raw_filename}', decoded='{filename}'")
    
    # 安全检查：防止路径遍历
    if '..' in filename or '/' in filename or '\\' in filename:
        return web.Response(status=400, text="Invalid filename")
    
    preview_path = os.path.join(CURRENT_DIR, "previews", filename)
    print(f"[PromptPresets] Looking for file at: {preview_path}")
    print(f"[PromptPresets] File exists: {os.path.exists(preview_path)}")
    
    if not os.path.exists(preview_path):
        return web.Response(status=404, text="Preview not found")
    
    # 根据扩展名设置 Content-Type
    ext = os.path.splitext(filename)[1].lower()
    content_types = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm'
    }
    content_type = content_types.get(ext, 'application/octet-stream')
    
    try:
        with open(preview_path, 'rb') as f:
            data = f.read()
        return web.Response(body=data, content_type=content_type)
    except Exception as e:
        print(f"[PromptPresets] Error serving preview: {e}")
        return web.Response(status=500, text="Error reading file")

# 空的节点映射（这是纯 UI 插件，没有节点）
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Web 目录
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
