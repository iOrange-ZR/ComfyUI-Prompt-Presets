import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

/**
 * Prompt Presets Extension - ComfyUI-Prompt-Presets
 * 独立的提示词预设管理插件
 * 
 * 功能：
 * - 悬浮圆形按钮，鼠标悬停显示级联菜单
 * - 点击预设追加到任何有 prompt/text 输入框的节点
 * - 用户自定义预设（localStorage 存储）
 * - 记录添加历史，支持选择性删除和编辑
 */

// 内置的提示词输入框 widget 名称列表
const BUILTIN_PROMPT_WIDGET_NAMES = ["prompt", "text", "positive", "negative", "clip_text", "string"];

// ========================================
// Widget 配置管理器（白名单/黑名单）
// ========================================

class WidgetConfigManager {
    constructor() {
        this.storageKey = "prompt_presets_widget_config";
        this.config = this.load();
    }

    load() {
        try {
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {
            console.error("[WidgetConfig] Failed to load:", e);
        }
        return { whitelist: [], blacklist: [] };
    }

    save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.config));
        } catch (e) {
            console.error("[WidgetConfig] Failed to save:", e);
        }
    }

    getWhitelist() {
        return this.config.whitelist || [];
    }

    getBlacklist() {
        return this.config.blacklist || [];
    }

    addToWhitelist(name) {
        if (!name || this.config.whitelist.includes(name)) return false;
        this.config.whitelist.push(name);
        this.save();
        return true;
    }

    removeFromWhitelist(name) {
        const idx = this.config.whitelist.indexOf(name);
        if (idx > -1) {
            this.config.whitelist.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    addToBlacklist(name) {
        if (!name || this.config.blacklist.includes(name)) return false;
        this.config.blacklist.push(name);
        this.save();
        return true;
    }

    removeFromBlacklist(name) {
        const idx = this.config.blacklist.indexOf(name);
        if (idx > -1) {
            this.config.blacklist.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }
}

const widgetConfigManager = new WidgetConfigManager();

// 检测 widget 是否为提示词输入框
function isPromptWidget(widget) {
    if (!widget) return false;

    // 黑名单优先检查（排除）
    if (widgetConfigManager.getBlacklist().includes(widget.name)) return false;

    // 用户白名单
    if (widgetConfigManager.getWhitelist().includes(widget.name)) return true;

    // 内置白名单
    if (BUILTIN_PROMPT_WIDGET_NAMES.includes(widget.name)) return true;

    // 类型匹配：customtext 通常是多行文本输入
    if (widget.type === "customtext") return true;

    // 多行字符串
    if (widget.options?.multiline) return true;

    return false;
}

// 获取节点中所有提示词 widget
function getAllPromptWidgets(node) {
    if (!node?.widgets) return [];
    return node.widgets.filter(w => isPromptWidget(w));
}

// ========================================
// 动态权重排序 - 按 Tier 重排提示词
// ========================================

// 缓存：preset prompt_value -> tier
let presetTierCache = null;

// 从加载的预设数据构建 tier 缓存
function buildPresetTierCache(presetsData) {
    const cache = {};
    if (!Array.isArray(presetsData)) return cache;

    for (const category of presetsData) {
        const tier = category.tier || 4; // 默认 Tier 4
        if (Array.isArray(category.presets)) {
            for (const preset of category.presets) {
                if (preset.prompt_value) {
                    cache[preset.prompt_value] = tier;
                }
            }
        }
    }
    return cache;
}

// 获取预设的 Tier（需要先加载数据）
function getPresetTier(promptValue) {
    if (!presetTierCache) return 4; // 默认 Tier 4（用户输入）
    return presetTierCache[promptValue] || 4;
}

// 重排提示词：按 Tier 排序
// 格式：【preset1】, 用户文本, 【preset2】
// 输出：按 Tier 1-7 排序的提示词
function reorderPromptByTier(text) {
    if (!text || !presetTierCache) return text;

    // 匹配所有 【xxx】 预设
    const presetRegex = /【([^】]+)】/g;
    const presets = [];
    let userText = text;

    // 提取所有预设
    let match;
    while ((match = presetRegex.exec(text)) !== null) {
        const fullMatch = match[0]; // 包括【】的完整匹配
        const innerValue = match[1]; // 不包括【】的内容
        const tier = getPresetTier(innerValue);
        presets.push({ fullMatch, innerValue, tier });
    }

    if (presets.length === 0) return text; // 没有预设，无需排序

    // 从文本中移除所有预设，保留用户文本
    for (const p of presets) {
        userText = userText.replace(p.fullMatch, "");
    }

    // 清理用户文本中的多余逗号和空格
    userText = userText
        .replace(/,\s*,/g, ",")
        .replace(/^\s*,\s*/, "")
        .replace(/\s*,\s*$/, "")
        .trim();

    // 按 Tier 排序预设
    presets.sort((a, b) => a.tier - b.tier);

    // 分组：Tier 1-3 在用户文本前，Tier 5-7 在用户文本后
    const beforeUser = presets.filter(p => p.tier < 4);
    const afterUser = presets.filter(p => p.tier >= 4);

    // 重建提示词
    const parts = [];

    // Tier 1-3 的预设
    for (const p of beforeUser) {
        parts.push(p.fullMatch);
    }

    // 用户文本 (Tier 4)
    if (userText) {
        parts.push(userText);
    }

    // Tier 5-7 的预设
    for (const p of afterUser) {
        parts.push(p.fullMatch);
    }

    return parts.join(", ");
}

// 获取节点中的第一个提示词 widget
function getPromptWidget(node) {
    if (!node?.widgets) return null;
    return node.widgets.find(w => isPromptWidget(w));
}

class PromptPresetsManager {
    constructor() {
        this.presets = null;
        this.loaded = false;
        // 存储每个节点的添加历史: { nodeId: [{value, customName}, ...] }
        this.addedHistory = new Map();
        this.customCounter = new Map(); // 用于生成 "自由预设N" 的计数器
    }

    async loadPresets() {
        if (this.loaded) return this.presets;

        try {
            // 使用新的 API 路径
            const resp = await api.fetchApi("/prompt_presets/data");
            if (resp.status === 200) {
                this.presets = await resp.json();
                this.loaded = true;

                // 构建 Tier 缓存用于优先级排序
                presetTierCache = buildPresetTierCache(this.presets);
                console.log("[PromptPresets] Loaded presets:", this.presets.length, "categories, tier cache built");
            } else {
                console.error("[PromptPresets] Failed to load presets:", resp.status);
                this.presets = [];
            }
        } catch (e) {
            console.error("[PromptPresets] Error loading presets:", e);
            this.presets = [];
        }
        return this.presets;
    }

    // 记录添加的预设
    recordAdded(nodeId, promptValue, presetName = null) {
        if (!this.addedHistory.has(nodeId)) {
            this.addedHistory.set(nodeId, []);
        }
        this.addedHistory.get(nodeId).push({
            value: promptValue,
            customName: presetName // 如果是原始预设，这里为 null
        });
    }

    // 获取节点的添加历史
    getHistory(nodeId) {
        return this.addedHistory.get(nodeId) || [];
    }

    // 从历史中移除
    removeFromHistory(nodeId, promptValue) {
        const history = this.addedHistory.get(nodeId);
        if (history) {
            const idx = history.findIndex(h => h.value === promptValue);
            if (idx > -1) {
                history.splice(idx, 1);
            }
        }
    }

    // 更新历史中的值（用于编辑功能）
    updateHistory(nodeId, oldValue, newValue) {
        const history = this.addedHistory.get(nodeId);
        if (history) {
            const item = history.find(h => h.value === oldValue);
            if (item) {
                item.value = newValue;
                // 设置自定义名称
                if (!item.customName) {
                    const counter = (this.customCounter.get(nodeId) || 0) + 1;
                    this.customCounter.set(nodeId, counter);
                    item.customName = `自由预设 ${counter}`;
                }
                return item.customName;
            }
        }
        return null;
    }

    // 获取所有预设值的列表（用于智能匹配）
    getAllPresetValues() {
        if (!this.presets) return [];
        const values = [];
        this.presets.forEach(cat => {
            cat.presets.forEach(p => {
                values.push({
                    category: cat.category,
                    name: p.sub_category,
                    value: p.prompt_value
                });
            });
        });
        return values;
    }

    // 智能匹配：检测 prompt 中包含哪些预设
    detectPresetsInPrompt(promptText) {
        const allPresets = this.getAllPresetValues();
        const detected = [];

        allPresets.forEach(preset => {
            // 检查是否包含带标记的预设值 【value】 或原始值
            const markedValue = `【${preset.value}】`;
            if (promptText.includes(markedValue) || promptText.includes(preset.value)) {
                // 返回实际在prompt中的值（带标记或不带标记）
                const actualValue = promptText.includes(markedValue) ? markedValue : preset.value;
                detected.push({
                    ...preset,
                    actualValue: actualValue
                });
            }
        });

        return detected;
    }
}

const presetsManager = new PromptPresetsManager();

// ========================================
// 自定义预设管理器（用户自定义的预设）
// ========================================

class CustomPresetsManager {
    constructor() {
        this.storageKey = "prompt_presets_custom";
        this.presets = this.load();
    }

    // 从 localStorage 加载
    load() {
        try {
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                return JSON.parse(data);
            }
        } catch (e) {
            console.error("[CustomPresets] Failed to load:", e);
        }
        return [];
    }

    // 保存到 localStorage
    save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.presets));
        } catch (e) {
            console.error("[CustomPresets] Failed to save:", e);
        }
    }

    // 获取所有自定义预设
    getAll() {
        return this.presets;
    }

    // 添加新预设
    add(name, value) {
        if (!name || !value) return false;
        this.presets.push({ name, value });
        this.save();
        return true;
    }

    // 删除预设
    remove(index) {
        if (index >= 0 && index < this.presets.length) {
            this.presets.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }

    // 更新预设
    update(index, name, value) {
        if (index >= 0 && index < this.presets.length) {
            this.presets[index] = { name, value };
            this.save();
            return true;
        }
        return false;
    }
}

const customPresetsManager = new CustomPresetsManager();

// ========================================
// 悬浮按钮和菜单 UI
// ========================================

class PromptPresetsUI {
    constructor() {
        this.floatBtn = null;
        this.mainMenu = null;
        this.subMenu = null;
        this.managePanel = null;
        this.previewPopup = null;
        this.isMenuOpen = false;
        this.hideTimeout = null;
    }

    createFloatingButton() {
        const STORAGE_KEY = "prompt_presets_btn_pos";

        const floatBtn = document.createElement("button");
        floatBtn.id = "prompt-presets-float-btn";
        floatBtn.innerText = "📝";
        floatBtn.title = "提示词预设 (可拖拽)";

        let savedPos = { right: 20, bottom: 80 };
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) savedPos = JSON.parse(stored);
        } catch (e) { }

        Object.assign(floatBtn.style, {
            position: "fixed",
            right: savedPos.right + "px",
            bottom: savedPos.bottom + "px",
            zIndex: "99998",
            width: "44px",
            height: "44px",
            borderRadius: "50%",
            background: "linear-gradient(135deg, #4a6ea5, #2a4a75)",
            color: "white",
            border: "2px solid #5a8ec5",
            cursor: "grab",
            fontSize: "20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 4px 8px rgba(0,0,0,0.4)",
            transition: "transform 0.1s, box-shadow 0.1s",
            userSelect: "none"
        });

        // 拖拽逻辑
        let isDragging = false;
        let hasMoved = false;
        let startX, startY, startRight, startBottom;

        floatBtn.onmousedown = (e) => {
            if (e.button !== 0) return;
            isDragging = true;
            hasMoved = false;
            startX = e.clientX;
            startY = e.clientY;
            startRight = parseInt(floatBtn.style.right);
            startBottom = parseInt(floatBtn.style.bottom);
            floatBtn.style.cursor = "grabbing";
            floatBtn.style.transition = "none";
            e.preventDefault();
        };

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            const dx = startX - e.clientX;
            const dy = startY - e.clientY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;

            let newRight = Math.max(5, Math.min(window.innerWidth - 50, startRight + dx));
            let newBottom = Math.max(5, Math.min(window.innerHeight - 50, startBottom + dy));

            floatBtn.style.right = newRight + "px";
            floatBtn.style.bottom = newBottom + "px";
        });

        document.addEventListener("mouseup", () => {
            if (!isDragging) return;
            isDragging = false;
            floatBtn.style.cursor = "grab";
            floatBtn.style.transition = "transform 0.1s, box-shadow 0.1s";

            const pos = {
                right: parseInt(floatBtn.style.right),
                bottom: parseInt(floatBtn.style.bottom)
            };
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pos)); } catch (e) { }
        });

        floatBtn.onmouseenter = () => {
            if (!isDragging) {
                floatBtn.style.transform = "scale(1.1)";
                floatBtn.style.boxShadow = "0 6px 12px rgba(0,0,0,0.5)";
                this.clearHideTimeout();
                this.showMainMenu();
            }
        };

        floatBtn.onmouseleave = (e) => {
            floatBtn.style.transform = "scale(1.0)";
            floatBtn.style.boxShadow = "0 4px 8px rgba(0,0,0,0.4)";
            this.scheduleHideMenu(e);
        };

        this.floatBtn = floatBtn;
        return floatBtn;
    }

    async showMainMenu() {
        if (this.isMenuOpen) return;

        const presets = await presetsManager.loadPresets();
        if (!presets || presets.length === 0) {
            this.showToast("未能加载预设数据", "warning");
            return;
        }

        const menu = document.createElement("div");
        menu.className = "prompt-presets-menu";
        Object.assign(menu.style, {
            position: "fixed",
            background: "linear-gradient(180deg, #333, #2a2a2a)",
            border: "1px solid #555",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: "99997",
            minWidth: "200px",
            padding: "8px 0",
            opacity: "0",
            transform: "translateY(10px)",
            transition: "opacity 0.2s, transform 0.2s"
        });

        // 类别菜单项
        presets.forEach((cat) => {
            const item = this.createMenuItem(cat.category, "▶");
            item.onmouseenter = () => {
                this.highlightItem(item, true);
                this.showSubMenu(cat, item);
            };
            item.onmouseleave = () => this.highlightItem(item, false);
            menu.appendChild(item);
        });

        // 分隔线1
        const divider1 = document.createElement("div");
        Object.assign(divider1.style, {
            height: "1px",
            background: "#555",
            margin: "8px 12px"
        });
        menu.appendChild(divider1);

        // ✨ 自定义预设 选项
        const customItem = this.createMenuItem("✨ 自定义", "▶");
        customItem.onmouseenter = () => {
            this.highlightItem(customItem, true);
            this.showCustomSubMenu(customItem);
        };
        customItem.onmouseleave = () => this.highlightItem(customItem, false);
        menu.appendChild(customItem);

        // 分隔线2
        const divider2 = document.createElement("div");
        Object.assign(divider2.style, {
            height: "1px",
            background: "#555",
            margin: "8px 12px"
        });
        menu.appendChild(divider2);

        // 管理已添加 选项
        const manageItem = this.createMenuItem("🗑️ 管理已添加", "");
        manageItem.onclick = () => {
            this.hideAllMenus();
            this.showManagePanel();
        };
        manageItem.onmouseenter = () => {
            this.highlightItem(manageItem, true);
            this.hideSubMenu();
        };
        manageItem.onmouseleave = () => this.highlightItem(manageItem, false);
        menu.appendChild(manageItem);

        // ⚙️ 设置 选项
        const settingsItem = this.createMenuItem("⚙️ 设置", "");
        settingsItem.onclick = () => {
            this.hideAllMenus();
            this.showSettingsPanel();
        };
        settingsItem.onmouseenter = () => {
            this.highlightItem(settingsItem, true);
            this.hideSubMenu();
        };
        settingsItem.onmouseleave = () => this.highlightItem(settingsItem, false);
        menu.appendChild(settingsItem);

        menu.onmouseenter = () => this.clearHideTimeout();
        menu.onmouseleave = (e) => this.scheduleHideMenu(e);

        document.body.appendChild(menu);

        // 定位
        const btnRect = this.floatBtn.getBoundingClientRect();
        let x = btnRect.left - 210;
        let y = btnRect.top;

        if (x < 10) x = btnRect.right + 10;
        if (y + 350 > window.innerHeight) y = window.innerHeight - 370;

        menu.style.left = x + "px";
        menu.style.top = y + "px";

        requestAnimationFrame(() => {
            menu.style.opacity = "1";
            menu.style.transform = "translateY(0)";
        });

        this.mainMenu = menu;
        this.isMenuOpen = true;
    }

    createMenuItem(text, arrow) {
        const item = document.createElement("div");
        Object.assign(item.style, {
            padding: "12px 18px",
            cursor: "pointer",
            fontSize: "14px",
            color: "#ddd",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            transition: "background 0.15s, padding-left 0.15s"
        });
        item.innerHTML = `<span>${text}</span>${arrow ? `<span style="opacity:0.5;font-size:11px;">${arrow}</span>` : ''}`;
        return item;
    }

    highlightItem(item, highlight) {
        if (highlight) {
            item.style.background = "linear-gradient(90deg, #3a6ea5, transparent)";
            item.style.paddingLeft = "22px";
            item.style.color = "#fff";
        } else {
            item.style.background = "transparent";
            item.style.paddingLeft = "18px";
            item.style.color = "#ddd";
        }
    }

    showSubMenu(category, parentItem) {
        this.hideSubMenu();

        const submenu = document.createElement("div");
        Object.assign(submenu.style, {
            position: "fixed",
            background: "linear-gradient(180deg, #383838, #2e2e2e)",
            border: "1px solid #555",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: "99996",
            minWidth: "320px",
            maxHeight: "400px",
            overflowY: "auto",
            padding: "8px 0",
            opacity: "0",
            transform: "translateX(10px)",
            transition: "opacity 0.15s, transform 0.15s"
        });

        category.presets.forEach(preset => {
            const item = document.createElement("div");
            Object.assign(item.style, {
                padding: "10px 16px",
                cursor: "pointer",
                fontSize: "13px",
                color: "#ccc",
                borderLeft: "3px solid transparent",
                transition: "all 0.12s",
                display: "flex",
                alignItems: "center",
                gap: "8px"
            });

            // 如果有预览，添加小图标
            if (preset.preview) {
                const icon = document.createElement("span");
                icon.textContent = "🖼️";
                icon.style.fontSize = "10px";
                icon.style.opacity = "0.6";
                item.appendChild(icon);
            }

            const text = document.createElement("span");
            text.textContent = preset.sub_category;
            item.appendChild(text);

            item.onmouseenter = (e) => {
                item.style.background = "linear-gradient(90deg, #3a6ea5, transparent)";
                item.style.color = "#fff";
                item.style.borderLeftColor = "#5ab0ff";
                item.style.paddingLeft = "20px";

                // 显示预览
                if (preset.preview) {
                    this.showPreviewPopup(preset.preview, e.clientX, e.clientY);
                }
            };
            item.onmouseleave = () => {
                item.style.background = "transparent";
                item.style.color = "#ccc";
                item.style.borderLeftColor = "transparent";
                item.style.paddingLeft = "16px";

                // 隐藏预览
                this.hidePreviewPopup();
            };

            item.onclick = () => {
                this.appendToPrompt(preset.prompt_value);
                this.hideAllMenus();
            };

            submenu.appendChild(item);
        });

        submenu.onmouseenter = () => this.clearHideTimeout();
        submenu.onmouseleave = (e) => this.scheduleHideMenu(e);

        document.body.appendChild(submenu);

        const menuRect = this.mainMenu.getBoundingClientRect();
        const itemRect = parentItem.getBoundingClientRect();
        let x = menuRect.left - 330;
        let y = itemRect.top - 8;

        if (x < 10) x = menuRect.right + 10;
        if (y + 400 > window.innerHeight) y = window.innerHeight - 410;
        if (y < 10) y = 10;

        submenu.style.left = x + "px";
        submenu.style.top = y + "px";

        requestAnimationFrame(() => {
            submenu.style.opacity = "1";
            submenu.style.transform = "translateX(0)";
        });

        this.subMenu = submenu;
    }

    // ========================================
    // 自定义预设子菜单
    // ========================================

    showCustomSubMenu(parentItem) {
        this.hideSubMenu();

        const customPresets = customPresetsManager.getAll();

        const submenu = document.createElement("div");
        Object.assign(submenu.style, {
            position: "fixed",
            background: "linear-gradient(180deg, #383838, #2e2e2e)",
            border: "1px solid #555",
            borderRadius: "10px",
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: "99996",
            minWidth: "280px",
            maxHeight: "400px",
            overflowY: "auto",
            padding: "8px 0",
            opacity: "0",
            transform: "translateX(10px)",
            transition: "opacity 0.15s, transform 0.15s"
        });

        // 显示用户的自定义预设
        if (customPresets.length > 0) {
            customPresets.forEach((preset, index) => {
                const item = document.createElement("div");
                Object.assign(item.style, {
                    padding: "10px 16px",
                    cursor: "pointer",
                    fontSize: "13px",
                    color: "#ccc",
                    borderLeft: "3px solid #9b59b6",
                    transition: "all 0.12s"
                });
                item.textContent = preset.name;

                item.onmouseenter = () => {
                    item.style.background = "linear-gradient(90deg, #9b59b6, transparent)";
                    item.style.color = "#fff";
                    item.style.paddingLeft = "20px";
                };
                item.onmouseleave = () => {
                    item.style.background = "transparent";
                    item.style.color = "#ccc";
                    item.style.paddingLeft = "16px";
                };

                item.onclick = () => {
                    this.appendToPrompt(preset.value);
                    this.hideAllMenus();
                };

                submenu.appendChild(item);
            });

            // 分隔线
            const divider = document.createElement("div");
            Object.assign(divider.style, {
                height: "1px",
                background: "#555",
                margin: "8px 12px"
            });
            submenu.appendChild(divider);
        }

        // 添加新预设 按钮
        const addItem = document.createElement("div");
        Object.assign(addItem.style, {
            padding: "10px 16px",
            cursor: "pointer",
            fontSize: "13px",
            color: "#5ab0ff",
            transition: "all 0.12s"
        });
        addItem.innerHTML = "➕ 添加新预设";
        addItem.onmouseenter = () => {
            addItem.style.background = "rgba(90, 176, 255, 0.2)";
            addItem.style.paddingLeft = "20px";
        };
        addItem.onmouseleave = () => {
            addItem.style.background = "transparent";
            addItem.style.paddingLeft = "16px";
        };
        addItem.onclick = () => {
            this.hideAllMenus();
            this.showAddCustomPresetDialog();
        };
        submenu.appendChild(addItem);

        // 管理自定义预设 按钮
        if (customPresets.length > 0) {
            const manageItem = document.createElement("div");
            Object.assign(manageItem.style, {
                padding: "10px 16px",
                cursor: "pointer",
                fontSize: "13px",
                color: "#888",
                transition: "all 0.12s"
            });
            manageItem.innerHTML = "✏️ 管理自定义预设";
            manageItem.onmouseenter = () => {
                manageItem.style.background = "rgba(136, 136, 136, 0.2)";
                manageItem.style.paddingLeft = "20px";
            };
            manageItem.onmouseleave = () => {
                manageItem.style.background = "transparent";
                manageItem.style.paddingLeft = "16px";
            };
            manageItem.onclick = () => {
                this.hideAllMenus();
                this.showManageCustomPresetsDialog();
            };
            submenu.appendChild(manageItem);
        }

        submenu.onmouseenter = () => this.clearHideTimeout();
        submenu.onmouseleave = (e) => this.scheduleHideMenu(e);

        document.body.appendChild(submenu);

        const menuRect = this.mainMenu.getBoundingClientRect();
        const itemRect = parentItem.getBoundingClientRect();
        let x = menuRect.left - 290;
        let y = itemRect.top - 8;

        if (x < 10) x = menuRect.right + 10;
        if (y + 300 > window.innerHeight) y = window.innerHeight - 310;
        if (y < 10) y = 10;

        submenu.style.left = x + "px";
        submenu.style.top = y + "px";

        requestAnimationFrame(() => {
            submenu.style.opacity = "1";
            submenu.style.transform = "translateX(0)";
        });

        this.subMenu = submenu;
    }

    // 添加自定义预设弹窗
    showAddCustomPresetDialog(editIndex = -1, editName = "", editValue = "") {
        const isEdit = editIndex >= 0;

        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "100000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            background: "linear-gradient(180deg, #3a3a3a, #2a2a2a)",
            borderRadius: "12px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            width: "450px",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px"
        });

        // 标题
        const title = document.createElement("h3");
        Object.assign(title.style, {
            margin: "0",
            color: "#fff",
            fontSize: "16px"
        });
        title.textContent = isEdit ? "✏️ 编辑自定义预设" : "✨ 添加自定义预设";
        panel.appendChild(title);

        // 名称输入
        const nameLabel = document.createElement("label");
        Object.assign(nameLabel.style, { color: "#aaa", fontSize: "13px" });
        nameLabel.textContent = "预设名称";
        panel.appendChild(nameLabel);

        const nameInput = document.createElement("input");
        Object.assign(nameInput.style, {
            padding: "10px",
            background: "#2a2a2a",
            border: "1px solid #555",
            borderRadius: "6px",
            color: "#fff",
            fontSize: "14px"
        });
        nameInput.placeholder = "例如：我的风格";
        nameInput.value = editName;
        panel.appendChild(nameInput);

        // 内容输入
        const valueLabel = document.createElement("label");
        Object.assign(valueLabel.style, { color: "#aaa", fontSize: "13px" });
        valueLabel.textContent = "提示词内容";
        panel.appendChild(valueLabel);

        const valueInput = document.createElement("textarea");
        Object.assign(valueInput.style, {
            padding: "10px",
            background: "#2a2a2a",
            border: "1px solid #555",
            borderRadius: "6px",
            color: "#fff",
            fontSize: "13px",
            minHeight: "100px",
            resize: "vertical",
            fontFamily: "monospace"
        });
        valueInput.placeholder = "例如：cinematic lighting, soft shadows, warm tones";
        valueInput.value = editValue;
        panel.appendChild(valueInput);

        // 按钮组
        const buttons = document.createElement("div");
        Object.assign(buttons.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            marginTop: "8px"
        });

        const cancelBtn = document.createElement("button");
        Object.assign(cancelBtn.style, {
            background: "#555",
            border: "none",
            color: "white",
            padding: "8px 16px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px"
        });
        cancelBtn.textContent = "取消";
        cancelBtn.onclick = () => overlay.remove();

        const saveBtn = document.createElement("button");
        Object.assign(saveBtn.style, {
            background: "linear-gradient(135deg, #9b59b6, #8e44ad)",
            border: "none",
            color: "white",
            padding: "8px 16px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px",
            fontWeight: "bold"
        });
        saveBtn.textContent = isEdit ? "保存修改" : "添加预设";
        saveBtn.onclick = () => {
            const name = nameInput.value.trim();
            const value = valueInput.value.trim();

            if (!name || !value) {
                this.showToast("请填写名称和内容", "warning");
                return;
            }

            if (isEdit) {
                customPresetsManager.update(editIndex, name, value);
                this.showToast("✓ 预设已更新", "success");
            } else {
                customPresetsManager.add(name, value);
                this.showToast("✓ 预设已添加", "success");
            }
            overlay.remove();
        };

        buttons.appendChild(cancelBtn);
        buttons.appendChild(saveBtn);
        panel.appendChild(buttons);

        overlay.appendChild(panel);
        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        document.body.appendChild(overlay);
        nameInput.focus();
    }

    // 管理自定义预设弹窗
    showManageCustomPresetsDialog() {
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "100000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            background: "linear-gradient(180deg, #3a3a3a, #2a2a2a)",
            borderRadius: "12px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            width: "500px",
            maxHeight: "70vh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
        });

        // 头部
        const header = document.createElement("div");
        Object.assign(header.style, {
            padding: "16px 20px",
            borderBottom: "1px solid #555",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        });
        header.innerHTML = `<h3 style="margin:0;color:#fff;font-size:16px;">✏️ 管理自定义预设</h3>`;

        const closeBtn = document.createElement("button");
        Object.assign(closeBtn.style, {
            background: "transparent",
            border: "none",
            color: "#888",
            fontSize: "20px",
            cursor: "pointer"
        });
        closeBtn.innerHTML = "×";
        closeBtn.onclick = () => overlay.remove();
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // 内容区
        const content = document.createElement("div");
        Object.assign(content.style, {
            padding: "16px 20px",
            overflowY: "auto",
            flex: "1"
        });

        const customPresets = customPresetsManager.getAll();

        if (customPresets.length === 0) {
            content.innerHTML = `<p style="color:#888;text-align:center;margin:40px 0;">暂无自定义预设</p>`;
        } else {
            customPresets.forEach((preset, index) => {
                const row = document.createElement("div");
                Object.assign(row.style, {
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "12px",
                    padding: "12px",
                    background: "#333",
                    borderRadius: "8px",
                    marginBottom: "8px"
                });

                const info = document.createElement("div");
                Object.assign(info.style, {
                    flex: "1",
                    minWidth: "0"
                });

                const name = document.createElement("div");
                Object.assign(name.style, {
                    color: "#9b59b6",
                    fontSize: "13px",
                    fontWeight: "bold",
                    marginBottom: "4px"
                });
                name.textContent = preset.name;
                info.appendChild(name);

                const value = document.createElement("div");
                Object.assign(value.style, {
                    color: "#aaa",
                    fontSize: "11px",
                    wordBreak: "break-word",
                    lineHeight: "1.4"
                });
                value.textContent = preset.value.length > 80 ? preset.value.substring(0, 80) + "..." : preset.value;
                info.appendChild(value);

                const btnGroup = document.createElement("div");
                Object.assign(btnGroup.style, {
                    display: "flex",
                    gap: "6px",
                    flexShrink: "0"
                });

                const editBtn = document.createElement("button");
                Object.assign(editBtn.style, {
                    background: "#3a6ea5",
                    border: "none",
                    color: "white",
                    padding: "4px 10px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "11px"
                });
                editBtn.textContent = "编辑";
                editBtn.onclick = () => {
                    overlay.remove();
                    this.showAddCustomPresetDialog(index, preset.name, preset.value);
                };

                const delBtn = document.createElement("button");
                Object.assign(delBtn.style, {
                    background: "#7a2d2d",
                    border: "none",
                    color: "white",
                    padding: "4px 10px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "11px"
                });
                delBtn.textContent = "删除";
                delBtn.onclick = () => {
                    customPresetsManager.remove(index);
                    row.style.opacity = "0.3";
                    row.style.pointerEvents = "none";
                    this.showToast("✓ 已删除", "success");
                };

                btnGroup.appendChild(editBtn);
                btnGroup.appendChild(delBtn);

                row.appendChild(info);
                row.appendChild(btnGroup);
                content.appendChild(row);
            });
        }

        panel.appendChild(content);

        // 底部
        const footer = document.createElement("div");
        Object.assign(footer.style, {
            padding: "12px 20px",
            borderTop: "1px solid #555",
            display: "flex",
            justifyContent: "flex-end"
        });

        const closeFooterBtn = document.createElement("button");
        Object.assign(closeFooterBtn.style, {
            background: "#555",
            border: "none",
            color: "white",
            padding: "8px 16px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px"
        });
        closeFooterBtn.textContent = "关闭";
        closeFooterBtn.onclick = () => overlay.remove();
        footer.appendChild(closeFooterBtn);

        panel.appendChild(footer);
        overlay.appendChild(panel);

        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        document.body.appendChild(overlay);
    }

    // ========================================
    // 管理面板
    // ========================================

    showManagePanel() {
        if (this.managePanel) {
            this.managePanel.remove();
        }

        const result = this.getTargetNode();
        if (result.error === "no_selection") {
            this.showToast("请先选中一个节点", "warning");
            return;
        }
        if (result.error === "no_text_widget") {
            this.showToast("选中的节点没有文本输入框", "warning");
            return;
        }
        if (result.error === "all_blacklisted") {
            this.showToast("选中节点的文本框都在黑名单中", "warning");
            return;
        }

        const targetNode = result.node;
        const promptWidget = getPromptWidget(targetNode);
        if (!promptWidget) {
            this.showToast("未找到提示词输入框", "warning");
            return;
        }

        const promptText = promptWidget.value || "";
        const nodeId = targetNode.id;

        // 获取添加历史和智能检测结果
        const history = presetsManager.getHistory(nodeId);
        const detected = presetsManager.detectPresetsInPrompt(promptText);

        // 检测用户自定义预设
        const customPresets = customPresetsManager.getAll();
        const detectedCustom = [];
        customPresets.forEach(preset => {
            const markedValue = `【${preset.value}】`;
            if (promptText.includes(markedValue) || promptText.includes(preset.value)) {
                const actualValue = promptText.includes(markedValue) ? markedValue : preset.value;
                detectedCustom.push({
                    name: preset.name,
                    value: preset.value,
                    actualValue: actualValue,
                    isCustomPreset: true
                });
            }
        });

        // 合并去重
        const itemsMap = new Map();

        // 历史记录优先（包含自定义名称的）
        history.forEach(historyItem => {
            if (promptText.includes(historyItem.value)) {
                itemsMap.set(historyItem.value, {
                    value: historyItem.value,
                    originalValue: historyItem.value,
                    customName: historyItem.customName,
                    source: "history"
                });
            }
        });

        // 智能检测的预设（如果不在历史中才添加）
        // 获取历史中所有的值，用于检查子串关系
        const historyValues = history.map(h => h.value);

        detected.forEach(preset => {
            // 使用 actualValue（带【】标记的值）作为 key
            const valueKey = preset.actualValue || preset.value;

            // 跳过已经在 itemsMap 中的
            if (itemsMap.has(valueKey)) {
                // 补充名称信息（如果历史中的项没有自定义名称）
                const item = itemsMap.get(valueKey);
                if (!item.customName) {
                    item.name = preset.name;
                    item.category = preset.category;
                }
                return;
            }

            // 跳过：如果预设值是历史中某个自定义值的子串
            // 这处理了用户编辑预设（添加/修改文本）后，原始预设仍被检测到的问题
            const isSubstringOfHistory = historyValues.some(histVal =>
                histVal.includes(preset.value) && histVal !== valueKey
            );
            if (isSubstringOfHistory) {
                return; // 跳过这个预设，因为它是某个自定义预设的子串
            }

            itemsMap.set(valueKey, {
                value: valueKey,
                originalValue: valueKey,
                name: preset.name,
                category: preset.category,
                source: "detected"
            });
        });

        // 处理用户自定义预设
        detectedCustom.forEach(preset => {
            const valueKey = preset.actualValue || preset.value;

            if (itemsMap.has(valueKey)) {
                // 补充名称信息
                const item = itemsMap.get(valueKey);
                if (!item.name) {
                    item.name = preset.name;
                    item.isCustomPreset = true;
                }
                return;
            }

            itemsMap.set(valueKey, {
                value: valueKey,
                originalValue: valueKey,
                name: preset.name,
                isCustomPreset: true,
                source: "detected"
            });
        });

        const items = Array.from(itemsMap.values());

        // 创建面板
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "100000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            background: "linear-gradient(180deg, #3a3a3a, #2a2a2a)",
            borderRadius: "12px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            width: "600px",
            maxHeight: "80vh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
        });

        // 头部
        const header = document.createElement("div");
        Object.assign(header.style, {
            padding: "16px 20px",
            borderBottom: "1px solid #555",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        });
        header.innerHTML = `<h3 style="margin:0;color:#fff;font-size:16px;">📝 管理已添加的预设</h3>`;

        const closeBtn = document.createElement("button");
        Object.assign(closeBtn.style, {
            background: "transparent",
            border: "none",
            color: "#888",
            fontSize: "20px",
            cursor: "pointer"
        });
        closeBtn.innerHTML = "×";
        closeBtn.onclick = () => overlay.remove();
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // 内容区
        const content = document.createElement("div");
        Object.assign(content.style, {
            padding: "16px 20px",
            overflowY: "auto",
            flex: "1"
        });

        const editedItems = [];

        if (items.length === 0) {
            content.innerHTML = `<p style="color:#888;text-align:center;margin:40px 0;">未检测到已添加的预设提示词</p>`;
        } else {
            const hint = document.createElement("p");
            Object.assign(hint.style, {
                color: "#888",
                fontSize: "12px",
                marginBottom: "12px"
            });
            hint.textContent = `检测到 ${items.length} 个预设提示词，可编辑后点击"应用更改"同步到 prompt：`;
            content.appendChild(hint);

            items.forEach((item, index) => {
                const row = document.createElement("div");
                Object.assign(row.style, {
                    padding: "12px",
                    background: "#333",
                    borderRadius: "8px",
                    marginBottom: "10px"
                });

                // 标题行
                const titleRow = document.createElement("div");
                Object.assign(titleRow.style, {
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "8px"
                });

                const nameLabel = document.createElement("span");
                Object.assign(nameLabel.style, {
                    color: "#5ab0ff",
                    fontSize: "13px",
                    fontWeight: "bold"
                });
                nameLabel.textContent = item.customName || item.name || `预设 ${index + 1}`;
                titleRow.appendChild(nameLabel);

                const delBtn = document.createElement("button");
                Object.assign(delBtn.style, {
                    background: "#7a2d2d",
                    border: "none",
                    color: "white",
                    padding: "4px 10px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "11px"
                });
                delBtn.textContent = "🗑️ 删除";
                delBtn.onmouseenter = () => delBtn.style.background = "#9a3d3d";
                delBtn.onmouseleave = () => delBtn.style.background = "#7a2d2d";
                delBtn.onclick = () => {
                    // 使用当前文本框中的值（用户可能已编辑）
                    this.removeFromPrompt(promptWidget, item.value, nodeId);
                    row.style.opacity = "0.3";
                    row.style.pointerEvents = "none";
                    item._deleted = true;
                };
                titleRow.appendChild(delBtn);

                row.appendChild(titleRow);

                // 可编辑文本框
                const textarea = document.createElement("textarea");
                Object.assign(textarea.style, {
                    width: "100%",
                    minHeight: "60px",
                    padding: "10px",
                    background: "#2a2a2a",
                    border: "1px solid #555",
                    borderRadius: "6px",
                    color: "#ddd",
                    fontSize: "12px",
                    lineHeight: "1.5",
                    resize: "vertical",
                    fontFamily: "monospace",
                    boxSizing: "border-box"
                });
                textarea.value = item.value;
                textarea.oninput = () => {
                    item.value = textarea.value;
                    item._modified = (item.value !== item.originalValue);
                    // 视觉反馈
                    if (item._modified) {
                        textarea.style.borderColor = "#5ab0ff";
                    } else {
                        textarea.style.borderColor = "#555";
                    }
                };
                textarea.onfocus = () => {
                    textarea.style.borderColor = "#5ab0ff";
                    textarea.style.outline = "none";
                };
                textarea.onblur = () => {
                    if (!item._modified) {
                        textarea.style.borderColor = "#555";
                    }
                };

                row.appendChild(textarea);
                content.appendChild(row);

                editedItems.push(item);
            });
        }

        panel.appendChild(content);

        // 底部
        const footer = document.createElement("div");
        Object.assign(footer.style, {
            padding: "12px 20px",
            borderTop: "1px solid #555",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "10px"
        });

        // 左侧按钮组
        const leftBtns = document.createElement("div");
        Object.assign(leftBtns.style, {
            display: "flex",
            gap: "10px"
        });

        if (items.length > 0) {
            const deleteAllBtn = document.createElement("button");
            Object.assign(deleteAllBtn.style, {
                background: "#7a2d2d",
                border: "none",
                color: "white",
                padding: "8px 14px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "12px"
            });
            deleteAllBtn.textContent = "删除全部";
            deleteAllBtn.onclick = () => {
                items.forEach(item => {
                    if (!item._deleted) {
                        // 使用当前文本框中的值
                        this.removeFromPrompt(promptWidget, item.value, nodeId, false);
                    }
                });
                this.showToast(`已删除全部预设`, "success");
                overlay.remove();
            };
            leftBtns.appendChild(deleteAllBtn);
        }

        footer.appendChild(leftBtns);

        // 右侧按钮组
        const rightBtns = document.createElement("div");
        Object.assign(rightBtns.style, {
            display: "flex",
            gap: "10px"
        });

        if (items.length > 0) {
            const applyBtn = document.createElement("button");
            Object.assign(applyBtn.style, {
                background: "linear-gradient(135deg, #2d7a2d, #1d5a1d)",
                border: "none",
                color: "white",
                padding: "8px 16px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "13px",
                fontWeight: "bold"
            });
            applyBtn.textContent = "✓ 应用更改";
            applyBtn.onmouseenter = () => applyBtn.style.background = "linear-gradient(135deg, #3d8a3d, #2d6a2d)";
            applyBtn.onmouseleave = () => applyBtn.style.background = "linear-gradient(135deg, #2d7a2d, #1d5a1d)";
            applyBtn.onclick = () => {
                let text = promptWidget.value || "";
                let changeCount = 0;

                editedItems.forEach(item => {
                    if (item._deleted) return;
                    if (item._modified && item.value !== item.originalValue) {
                        // 替换原始值为编辑后的值
                        if (text.includes(item.originalValue)) {
                            text = text.replace(item.originalValue, item.value);
                            changeCount++;

                            // 先删除原始条目
                            presetsManager.removeFromHistory(nodeId, item.originalValue);

                            // 再添加新条目（带自定义名称）
                            if (item.value.trim()) {
                                const counter = (presetsManager.customCounter.get(nodeId) || 0) + 1;
                                presetsManager.customCounter.set(nodeId, counter);
                                const customName = `自由预设 ${counter}`;
                                presetsManager.recordAdded(nodeId, item.value, customName);
                                item.customName = customName;
                            }
                        }
                    }
                });

                // 清理多余逗号
                text = text.replace(/,\s*,/g, ",").replace(/^\s*,\s*/, "").replace(/\s*,\s*$/, "").trim();

                promptWidget.value = text;
                if (promptWidget.callback) {
                    promptWidget.callback(promptWidget.value);
                }
                app.graph.setDirtyCanvas(true, true);

                if (changeCount > 0) {
                    this.showToast(`✓ 已应用 ${changeCount} 处更改`, "success");
                } else {
                    this.showToast("没有需要应用的更改", "info");
                }
                overlay.remove();
            };
            rightBtns.appendChild(applyBtn);
        }

        const closeFooterBtn = document.createElement("button");
        Object.assign(closeFooterBtn.style, {
            background: "#555",
            border: "none",
            color: "white",
            padding: "8px 16px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px"
        });
        closeFooterBtn.textContent = "关闭";
        closeFooterBtn.onclick = () => overlay.remove();
        rightBtns.appendChild(closeFooterBtn);

        footer.appendChild(rightBtns);
        panel.appendChild(footer);
        overlay.appendChild(panel);

        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        document.body.appendChild(overlay);
        this.managePanel = overlay;
    }

    // ========================================
    // 设置面板（白名单/黑名单管理）
    // ========================================

    showSettingsPanel() {
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "100000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            background: "linear-gradient(180deg, #3a3a3a, #2a2a2a)",
            borderRadius: "12px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            width: "550px",
            maxHeight: "80vh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
        });

        // 头部
        const header = document.createElement("div");
        Object.assign(header.style, {
            padding: "16px 20px",
            borderBottom: "1px solid #555",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        });
        header.innerHTML = `<h3 style="margin:0;color:#fff;font-size:16px;">⚙️ Widget 配置设置</h3>`;

        const closeBtn = document.createElement("button");
        Object.assign(closeBtn.style, {
            background: "transparent",
            border: "none",
            color: "#888",
            fontSize: "20px",
            cursor: "pointer"
        });
        closeBtn.innerHTML = "×";
        closeBtn.onclick = () => overlay.remove();
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // 标签页
        const tabs = document.createElement("div");
        Object.assign(tabs.style, {
            display: "flex",
            borderBottom: "1px solid #444"
        });

        let activeTab = "whitelist";

        const createTab = (id, label) => {
            const tab = document.createElement("button");
            Object.assign(tab.style, {
                flex: "1",
                padding: "12px",
                background: "transparent",
                border: "none",
                color: id === activeTab ? "#5ab0ff" : "#888",
                fontSize: "13px",
                cursor: "pointer",
                borderBottom: id === activeTab ? "2px solid #5ab0ff" : "2px solid transparent",
                transition: "all 0.15s"
            });
            tab.textContent = label;
            tab.onclick = () => {
                activeTab = id;
                renderContent();
            };
            return tab;
        };

        const whitelistTab = createTab("whitelist", "📋 白名单");
        const blacklistTab = createTab("blacklist", "🚫 黑名单");
        tabs.appendChild(whitelistTab);
        tabs.appendChild(blacklistTab);
        panel.appendChild(tabs);

        // 内容区
        const content = document.createElement("div");
        Object.assign(content.style, {
            padding: "16px 20px",
            overflowY: "auto",
            flex: "1"
        });
        panel.appendChild(content);

        const renderContent = () => {
            // 更新标签样式
            whitelistTab.style.color = activeTab === "whitelist" ? "#5ab0ff" : "#888";
            whitelistTab.style.borderBottom = activeTab === "whitelist" ? "2px solid #5ab0ff" : "2px solid transparent";
            blacklistTab.style.color = activeTab === "blacklist" ? "#5ab0ff" : "#888";
            blacklistTab.style.borderBottom = activeTab === "blacklist" ? "2px solid #5ab0ff" : "2px solid transparent";

            content.innerHTML = "";

            const isWhitelist = activeTab === "whitelist";
            const items = isWhitelist ? widgetConfigManager.getWhitelist() : widgetConfigManager.getBlacklist();
            const builtinNames = BUILTIN_PROMPT_WIDGET_NAMES;

            // 说明
            const desc = document.createElement("p");
            Object.assign(desc.style, {
                color: "#aaa",
                fontSize: "12px",
                marginBottom: "16px",
                lineHeight: "1.5"
            });
            if (isWhitelist) {
                desc.innerHTML = `<b>白名单</b>：额外识别为提示词输入框的 widget 名称。<br>内置白名单：<code style="background:#444;padding:2px 6px;border-radius:3px;color:#5ab0ff;">${builtinNames.join(", ")}</code>`;
            } else {
                desc.innerHTML = `<b>黑名单</b>：排除这些 widget，即使它们符合提示词输入框的条件也不会被识别。`;
            }
            content.appendChild(desc);

            // 添加输入框
            const addRow = document.createElement("div");
            Object.assign(addRow.style, {
                display: "flex",
                gap: "8px",
                marginBottom: "16px"
            });

            const input = document.createElement("input");
            Object.assign(input.style, {
                flex: "1",
                padding: "10px",
                background: "#2a2a2a",
                border: "1px solid #555",
                borderRadius: "6px",
                color: "#fff",
                fontSize: "13px"
            });
            input.placeholder = "输入 widget 名称...";

            const addBtn = document.createElement("button");
            Object.assign(addBtn.style, {
                background: isWhitelist ? "linear-gradient(135deg, #3a6ea5, #2a5a85)" : "linear-gradient(135deg, #7a3a3a, #5a2a2a)",
                border: "none",
                color: "white",
                padding: "10px 16px",
                borderRadius: "6px",
                cursor: "pointer",
                fontSize: "13px"
            });
            addBtn.textContent = "添加";
            addBtn.onclick = () => {
                const name = input.value.trim();
                if (!name) {
                    this.showToast("请输入 widget 名称", "warning");
                    return;
                }
                const success = isWhitelist
                    ? widgetConfigManager.addToWhitelist(name)
                    : widgetConfigManager.addToBlacklist(name);
                if (success) {
                    this.showToast(`✓ 已添加到${isWhitelist ? "白" : "黑"}名单`, "success");
                    input.value = "";
                    renderContent();
                } else {
                    this.showToast("该名称已存在", "warning");
                }
            };

            addRow.appendChild(input);
            addRow.appendChild(addBtn);
            content.appendChild(addRow);

            // 列表
            if (items.length === 0) {
                const empty = document.createElement("p");
                Object.assign(empty.style, {
                    color: "#666",
                    textAlign: "center",
                    padding: "30px 0"
                });
                empty.textContent = `暂无自定义${isWhitelist ? "白" : "黑"}名单项`;
                content.appendChild(empty);
            } else {
                items.forEach((name, index) => {
                    const row = document.createElement("div");
                    Object.assign(row.style, {
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 12px",
                        background: "#333",
                        borderRadius: "6px",
                        marginBottom: "6px"
                    });

                    const label = document.createElement("span");
                    Object.assign(label.style, {
                        color: isWhitelist ? "#5ab0ff" : "#ff7a7a",
                        fontSize: "13px",
                        fontFamily: "monospace"
                    });
                    label.textContent = name;

                    const delBtn = document.createElement("button");
                    Object.assign(delBtn.style, {
                        background: "#7a2d2d",
                        border: "none",
                        color: "white",
                        padding: "4px 10px",
                        borderRadius: "4px",
                        cursor: "pointer",
                        fontSize: "11px"
                    });
                    delBtn.textContent = "删除";
                    delBtn.onclick = () => {
                        const success = isWhitelist
                            ? widgetConfigManager.removeFromWhitelist(name)
                            : widgetConfigManager.removeFromBlacklist(name);
                        if (success) {
                            this.showToast("✓ 已删除", "success");
                            renderContent();
                        }
                    };

                    row.appendChild(label);
                    row.appendChild(delBtn);
                    content.appendChild(row);
                });
            }
        };

        renderContent();

        // 底部
        const footer = document.createElement("div");
        Object.assign(footer.style, {
            padding: "12px 20px",
            borderTop: "1px solid #555",
            display: "flex",
            justifyContent: "flex-end"
        });

        const closeFooterBtn = document.createElement("button");
        Object.assign(closeFooterBtn.style, {
            background: "#555",
            border: "none",
            color: "white",
            padding: "8px 16px",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "13px"
        });
        closeFooterBtn.textContent = "关闭";
        closeFooterBtn.onclick = () => overlay.remove();
        footer.appendChild(closeFooterBtn);

        panel.appendChild(footer);
        overlay.appendChild(panel);

        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        document.body.appendChild(overlay);
    }

    // ========================================
    // 核心逻辑
    // ========================================

    getTargetNode() {
        // 只使用用户选中的节点，不自动查找
        const selectedNodes = app.graph._nodes.filter(n => n.is_selected);

        if (selectedNodes.length === 0) {
            return { node: null, error: "no_selection" };
        }

        // 使用第一个选中的节点
        const targetNode = selectedNodes[0];

        // 检查节点是否有任何文本类 widget（不考虑黑名单）
        const allTextWidgets = targetNode.widgets?.filter(w => {
            // 检查是否为文本类型（但不检查黑名单）
            if (BUILTIN_PROMPT_WIDGET_NAMES.includes(w.name)) return true;
            if (widgetConfigManager.getWhitelist().includes(w.name)) return true;
            if (w.type === "customtext") return true;
            if (w.options?.multiline) return true;
            return false;
        }) || [];

        if (allTextWidgets.length === 0) {
            return { node: null, error: "no_text_widget" };
        }

        // 检查是否所有文本 widget 都在黑名单中
        const blacklistedWidgets = allTextWidgets.filter(w =>
            widgetConfigManager.getBlacklist().includes(w.name)
        );

        if (blacklistedWidgets.length === allTextWidgets.length) {
            // 所有文本 widget 都被黑名单排除
            return { node: targetNode, error: "all_blacklisted", blacklistedNames: blacklistedWidgets.map(w => w.name) };
        }

        return { node: targetNode, error: null };
    }

    appendToPrompt(value, targetWidget = null) {
        if (!value) return;

        const result = this.getTargetNode();

        if (result.error === "no_selection") {
            this.showToast("请先选中一个有文本输入框的节点", "warning");
            return;
        }

        if (result.error === "no_text_widget") {
            this.showToast("选中的节点没有文本输入框", "warning");
            return;
        }

        if (result.error === "all_blacklisted") {
            const names = result.blacklistedNames.join(", ");
            this.showToast(`选中节点的文本框 [${names}] 在黑名单中，无法添加预设`, "warning");
            return;
        }

        const targetNode = result.node;
        const allPromptWidgets = getAllPromptWidgets(targetNode);

        if (allPromptWidgets.length === 0) {
            this.showToast("未找到可用的提示词输入框", "warning");
            return;
        }

        // 如果有多个输入框且没有指定目标，弹出选择对话框
        if (allPromptWidgets.length > 1 && !targetWidget) {
            this.showWidgetSelectionDialog(targetNode, allPromptWidgets, value);
            return;
        }

        const promptWidget = targetWidget || allPromptWidgets[0];
        this.doAppendToWidget(promptWidget, value, targetNode.id);
    }

    // 实际执行添加操作
    doAppendToWidget(promptWidget, value, nodeId) {
        // 用【】包裹预设值，便于识别
        const markedValue = `【${value}】`;

        const currentValue = promptWidget.value || "";

        if (currentValue.trim() === "") {
            promptWidget.value = markedValue;
        } else {
            promptWidget.value = currentValue.trimEnd();
            if (!promptWidget.value.endsWith(",")) {
                promptWidget.value += ", ";
            } else {
                promptWidget.value += " ";
            }
            promptWidget.value += markedValue;
        }

        // 按 Tier 重排提示词顺序
        promptWidget.value = reorderPromptByTier(promptWidget.value);

        // 记录添加历史（存储带标记的值）
        presetsManager.recordAdded(nodeId, markedValue);

        if (promptWidget.callback) {
            promptWidget.callback(promptWidget.value);
        }

        app.graph.setDirtyCanvas(true, true);
        this.showToast("✓ 已添加提示词（已按优先级排序）", "success");
    }

    // 多输入框选择对话框
    showWidgetSelectionDialog(node, widgets, presetValue) {
        const overlay = document.createElement("div");
        Object.assign(overlay.style, {
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            bottom: "0",
            background: "rgba(0,0,0,0.6)",
            zIndex: "100000",
            display: "flex",
            alignItems: "center",
            justifyContent: "center"
        });

        const panel = document.createElement("div");
        Object.assign(panel.style, {
            background: "linear-gradient(180deg, #3a3a3a, #2a2a2a)",
            borderRadius: "12px",
            boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
            width: "450px",
            maxHeight: "70vh",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden"
        });

        // 头部
        const header = document.createElement("div");
        Object.assign(header.style, {
            padding: "16px 20px",
            borderBottom: "1px solid #555",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
        });
        header.innerHTML = `<h3 style="margin:0;color:#fff;font-size:16px;">🎯 选择目标输入框</h3>`;

        const closeBtn = document.createElement("button");
        Object.assign(closeBtn.style, {
            background: "transparent",
            border: "none",
            color: "#888",
            fontSize: "20px",
            cursor: "pointer"
        });
        closeBtn.innerHTML = "×";
        closeBtn.onclick = () => overlay.remove();
        header.appendChild(closeBtn);
        panel.appendChild(header);

        // 提示
        const hint = document.createElement("div");
        Object.assign(hint.style, {
            padding: "12px 20px",
            color: "#aaa",
            fontSize: "13px",
            borderBottom: "1px solid #444"
        });
        hint.innerHTML = `节点 <b style="color:#5ab0ff">${node.title || node.type}</b> 有多个文本输入框，请选择要添加预设的目标：`;
        panel.appendChild(hint);

        // 选项列表
        const content = document.createElement("div");
        Object.assign(content.style, {
            padding: "12px 20px",
            overflowY: "auto",
            flex: "1"
        });

        widgets.forEach((widget, index) => {
            const option = document.createElement("div");
            Object.assign(option.style, {
                padding: "12px 16px",
                background: "#333",
                borderRadius: "8px",
                marginBottom: "8px",
                cursor: "pointer",
                border: "2px solid transparent",
                transition: "all 0.15s"
            });

            const preview = (widget.value || "").substring(0, 50);
            option.innerHTML = `
                <div style="display:flex;align-items:center;gap:10px;">
                    <span style="background:#4a6ea5;color:white;padding:2px 8px;border-radius:4px;font-size:11px;">${widget.name}</span>
                    <span style="color:#ccc;font-size:13px;">${widget.type || "text"}</span>
                </div>
                <div style="color:#888;font-size:11px;margin-top:6px;word-break:break-word;">
                    ${preview ? preview + (widget.value?.length > 50 ? "..." : "") : "<i>（空）</i>"}
                </div>
            `;

            option.onmouseenter = () => {
                option.style.background = "#3a3a3a";
                option.style.borderColor = "#5ab0ff";
            };
            option.onmouseleave = () => {
                option.style.background = "#333";
                option.style.borderColor = "transparent";
            };

            option.onclick = () => {
                overlay.remove();
                this.doAppendToWidget(widget, presetValue, node.id);
            };

            content.appendChild(option);
        });

        panel.appendChild(content);
        overlay.appendChild(panel);

        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.remove();
        };

        document.body.appendChild(overlay);
    }

    removeFromPrompt(promptWidget, value, nodeId, showNotify = true) {
        if (!value || !promptWidget) return;

        let text = promptWidget.value || "";

        // 尝试多种匹配模式
        const patterns = [
            value + ", ",
            ", " + value,
            value
        ];

        let removed = false;
        for (const pattern of patterns) {
            if (text.includes(pattern)) {
                text = text.replace(pattern, "");
                removed = true;
                break;
            }
        }

        // 清理多余的逗号和空格
        text = text.replace(/,\s*,/g, ",").replace(/^\s*,\s*/, "").replace(/\s*,\s*$/, "").trim();

        promptWidget.value = text;

        // 从历史中移除
        presetsManager.removeFromHistory(nodeId, value);

        if (promptWidget.callback) {
            promptWidget.callback(promptWidget.value);
        }

        app.graph.setDirtyCanvas(true, true);

        if (showNotify) {
            this.showToast("✓ 已删除", "success");
        }
    }

    showToast(message, type = "info") {
        const existing = document.querySelector(".prompt-presets-toast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.className = "prompt-presets-toast";

        const colors = {
            success: "#2d7a2d",
            warning: "#8a6d2a",
            error: "#7a2d2d",
            info: "#2d5a7a"
        };

        Object.assign(toast.style, {
            position: "fixed",
            bottom: "140px",
            right: "20px",
            padding: "10px 18px",
            background: colors[type] || colors.info,
            color: "white",
            borderRadius: "6px",
            fontSize: "13px",
            zIndex: "100001",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
            opacity: "0",
            transform: "translateY(10px)",
            transition: "opacity 0.2s, transform 0.2s"
        });
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.opacity = "1";
            toast.style.transform = "translateY(0)";
        });

        setTimeout(() => {
            toast.style.opacity = "0";
            toast.style.transform = "translateY(10px)";
            setTimeout(() => toast.remove(), 200);
        }, 2000);
    }

    scheduleHideMenu(e) {
        this.hideTimeout = setTimeout(() => {
            const isOnButton = this.floatBtn?.matches(":hover");
            const isOnMenu = this.mainMenu?.matches(":hover");
            const isOnSubmenu = this.subMenu?.matches(":hover");

            if (!isOnButton && !isOnMenu && !isOnSubmenu) {
                this.hideAllMenus();
            }
        }, 150);
    }

    clearHideTimeout() {
        if (this.hideTimeout) {
            clearTimeout(this.hideTimeout);
            this.hideTimeout = null;
        }
    }

    hideSubMenu() {
        if (this.subMenu) {
            this.subMenu.remove();
            this.subMenu = null;
        }
    }

    // 显示预览弹窗
    showPreviewPopup(filename, mouseX, mouseY) {
        this.hidePreviewPopup();

        const popup = document.createElement("div");
        Object.assign(popup.style, {
            position: "fixed",
            background: "linear-gradient(180deg, #2a2a2a, #1a1a1a)",
            border: "2px solid #5ab0ff",
            borderRadius: "10px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
            zIndex: "100002",
            padding: "8px",
            maxWidth: "350px",
            maxHeight: "300px",
            overflow: "hidden",
            opacity: "0",
            transform: "scale(0.9)",
            transition: "opacity 0.15s, transform 0.15s"
        });

        const previewUrl = `/prompt_presets/preview/${encodeURIComponent(filename)}`;
        const ext = filename.split('.').pop().toLowerCase();
        const isVideo = ['mp4', 'webm'].includes(ext);

        if (isVideo) {
            const video = document.createElement("video");
            Object.assign(video.style, {
                width: "100%",
                height: "auto",
                maxHeight: "280px",
                borderRadius: "6px",
                display: "block"
            });
            video.src = previewUrl;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            popup.appendChild(video);
        } else {
            const img = document.createElement("img");
            Object.assign(img.style, {
                width: "100%",
                height: "auto",
                maxHeight: "280px",
                borderRadius: "6px",
                display: "block",
                objectFit: "contain"
            });
            img.src = previewUrl;
            img.alt = filename;
            img.onerror = () => {
                img.style.display = "none";
                popup.innerHTML = `<p style="color:#888;padding:20px;text-align:center;">预览加载失败</p>`;
            };
            popup.appendChild(img);
        }

        document.body.appendChild(popup);

        // 定位：在子菜单的左侧显示，不遮挡菜单
        const popupWidth = 350;
        const popupHeight = 300;

        // 获取子菜单位置
        let x, y;
        if (this.subMenu) {
            const subMenuRect = this.subMenu.getBoundingClientRect();
            // 放在子菜单左侧
            x = subMenuRect.left - popupWidth - 15;
            y = mouseY - 100;

            // 如果左侧空间不足，放在右侧
            if (x < 10) {
                x = subMenuRect.right + 15;
            }
        } else {
            x = mouseX - popupWidth - 20;
            y = mouseY - 50;
        }

        // 确保不超出屏幕
        if (x + popupWidth > window.innerWidth - 10) {
            x = window.innerWidth - popupWidth - 10;
        }
        if (x < 10) x = 10;
        if (y + popupHeight > window.innerHeight - 10) {
            y = window.innerHeight - popupHeight - 10;
        }
        if (y < 10) y = 10;

        popup.style.left = x + "px";
        popup.style.top = y + "px";

        requestAnimationFrame(() => {
            popup.style.opacity = "1";
            popup.style.transform = "scale(1)";
        });

        this.previewPopup = popup;
    }

    // 隐藏预览弹窗
    hidePreviewPopup() {
        if (this.previewPopup) {
            this.previewPopup.remove();
            this.previewPopup = null;
        }
    }

    hideAllMenus() {
        this.clearHideTimeout();
        this.hideSubMenu();
        this.hidePreviewPopup();
        if (this.mainMenu) {
            this.mainMenu.remove();
            this.mainMenu = null;
        }
        this.isMenuOpen = false;
    }
}

// ========================================
// 注册扩展
// ========================================

app.registerExtension({
    name: "ComfyUI.PromptPresets",

    async setup() {
        console.log("%c[PromptPresets] Extension Loading...", "color: #5ab0ff; font-weight: bold;");

        try {
            await presetsManager.loadPresets();

            const ui = new PromptPresetsUI();
            const floatBtn = ui.createFloatingButton();
            document.body.appendChild(floatBtn);

            console.log("[PromptPresets] Floating button with manage feature injected.");

        } catch (e) {
            console.error("[PromptPresets] Fatal error in setup:", e);
        }
    }
});

console.log("[ComfyUI-Prompt-Presets] Extension loaded");
