import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  BACKEND_EN,
  COMMON_EN,
  getPrefs,
  localeTag,
  setLocale,
  setTheme,
  subscribe,
  translate,
  translateDynamic,
  type Dict,
  type ThemeMode,
  type Vars,
} from "../../../../packages/i18n/prefs";

/** Rename 专属文案 */
const RENAME_EN: Dict = {
  "打开文件夹": "Open folder",
  "选择一个文件夹开始": "Pick a folder to start",
  "模板": "Pattern",
  "起始序号": "Start",
  "位数": "Digits",
  "可用变量": "Tokens",
  "原名": "Original",
  "新名": "New name",
  "大小": "Size",
  "全选": "Select all",
  "反选": "Invert",
  "已选 {n} 项": "{n} selected",
  "执行改名": "Rename",
  "撤销上一次": "Undo",
  "冲突：重名": "Conflict: duplicate",
  "冲突：已存在": "Conflict: exists",
  "没有需要改名的文件": "Nothing to rename",
  "改名完成：{n} 项": "Renamed {n} items",
  "已撤销": "Reverted",
  "撤销失败：{msg}": "Undo failed: {msg}",
  "执行失败：{msg}": "Failed: {msg}",
  "预览": "Preview",
  "包含子文件夹": "Include folders",
  "刷新": "Refresh",
  "示例": "Example",
  "窗口操作失败：{msg}": "Window action failed: {msg}",
  "关闭": "Close",
  "失败": "Failed",
  "完成": "Done",
  "查找替换": "Find & replace",
  "查找": "Find",
  "替换为": "Replace with",
  "正则": "Regex",
  "区分大小写": "Match case",
  "正则可用 $1 $2 引用捕获组，替换全部匹配项": "Regex supports $1 $2 capture groups; all matches are replaced",
  "扩展名": "Extension",
  "保持原样": "Keep",
  "小写": "lower",
  "大写": "UPPER",
  "排序": "Sort",
  "名称": "Name",
  "时间": "Date",
  "撤销（{n}）": "Undo ({n})",
  "预设方案": "Presets",
  "保存当前": "Save",
  "删除": "Delete",
  "暂无预设": "No presets yet",
  "已保存预设": "Preset saved",
  "还有 {n} 项未显示": "{n} more not shown",
  "非法正则": "Invalid regular expression",
};

const EN: Dict = { ...COMMON_EN, ...RENAME_EN };

export function useI18n() {
  const prefs = useSyncExternalStore(subscribe, getPrefs, getPrefs);
  const t = useCallback((zh: string, vars?: Vars) => translate(zh, vars, prefs.locale, EN), [prefs.locale]);
  const td = useCallback((text: string) => translateDynamic(text, prefs.locale, BACKEND_EN), [prefs.locale]);
  return { ...prefs, t, td, tag: localeTag(prefs.locale) };
}

/* ---------------- 偏好控件 ---------------- */

const NEXT_THEME: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

function MoonIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="3" y="4" width="18" height="13" rx="1" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

export function PreferencePanel({ variant = "inline" }: { variant?: "inline" | "popover" }) {
  const { theme, locale, t } = useI18n();
  const themes: ThemeMode[] = ["dark", "light", "system"];
  return (
    <div className={variant === "popover" ? "pref-pop" : "pref-inline"}>
      <div className="pref-section">
        <span className="grow">{t("外观")}</span>
        <div className="pref-seg">
          {themes.map((m) => (
            <button key={m} className={theme === m ? "on" : ""} onClick={() => setTheme(m)}>
              {m === "dark" ? t("黑夜") : m === "light" ? t("白昼") : t("跟随系统")}
            </button>
          ))}
        </div>
      </div>
      <div className="pref-section">
        <span className="grow">{t("语言")}</span>
        <div className="pref-seg">
          <button className={locale === "zh" ? "on" : ""} onClick={() => setLocale("zh")}>中文</button>
          <button className={locale === "en" ? "on" : ""} onClick={() => setLocale("en")}>English</button>
        </div>
      </div>
    </div>
  );
}

export function PreferenceControls() {
  const { theme, locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const label = theme === "dark" ? t("外观：黑夜") : theme === "light" ? t("外观：白昼") : t("外观：跟随系统");

  return (
    <div className="pref-group" ref={ref}>
      <button className="pref-btn" title={label} aria-label={label} onClick={() => setTheme(NEXT_THEME[theme])}>
        {theme === "dark" ? <MoonIcon /> : theme === "light" ? <SunIcon /> : <SystemIcon />}
      </button>
      <button
        className="pref-btn mono"
        title={t("切换语言")}
        aria-label={t("切换语言")}
        onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
      >
        {locale === "zh" ? "中" : "EN"}
      </button>
      <button className="pref-btn" title={t("外观")} aria-label={t("外观")} onClick={() => setOpen((v) => !v)}>
        <SlidersIcon />
      </button>
      {open && <PreferencePanel variant="popover" />}
    </div>
  );
}
