import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { PreferenceControls, useI18n } from "./lib/i18n";
import { fmtSize, isShell } from "./lib/format";
import { CloseIcon, DirIcon, FileIcon, MaxIcon, MinIcon } from "./components/icons";

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  ext: string;
  modified: number;
}

interface Report {
  renamed: number;
  errors: string[];
  undoDepth: number;
}

/** 改名方式：模板拼装 / 查找替换 */
type Mode = "pattern" | "replace";
type SortKey = "name" | "time" | "size";
type ExtCase = "keep" | "lower" | "upper";

interface Preset {
  label: string;
  mode: Mode;
  pattern: string;
  find: string;
  rep: string;
  regex: boolean;
  start: number;
  pad: number;
}

type Toast = { kind: "ok" | "bad"; text: string } | null;

const PRESET_KEY = "shadowmoon.rename.presets";
/** 表格最多渲染这么多行，超出只提示；实际改名不受影响 */
const ROW_LIMIT = 400;

const DEMO_ENTRIES: Entry[] = [
  { name: "IMG_0421.JPG", path: "D:/Photos/IMG_0421.JPG", isDir: false, size: 3_400_000, ext: "jpg", modified: 1715162400 },
  { name: "IMG_0422.JPG", path: "D:/Photos/IMG_0422.JPG", isDir: false, size: 3_120_000, ext: "jpg", modified: 1715162540 },
  { name: "Screenshot 2024-05-11.png", path: "D:/Photos/Screenshot.png", isDir: false, size: 840_000, ext: "png", modified: 1715335200 },
  { name: "旅行 001.jpg", path: "D:/Photos/旅行 001.jpg", isDir: false, size: 5_100_000, ext: "jpg", modified: 1715421600 },
];

const DATE_TOKENS = ["{name}", "{n}", "{ext}", "{date}"];

/** 文件名里不能出现的字符，统一替换成下划线。 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+$/, "");
}

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 时间戳（秒）→ YYYYMMDD，取文件修改时间，缺省用今天。 */
function stamp(sec: number): string {
  const d = sec > 0 ? new Date(sec * 1000) : new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function applyExtCase(name: string, mode: ExtCase): string {
  if (mode === "keep") return name;
  const { base, ext } = splitName(name);
  if (!ext) return name;
  return `${base}.${mode === "lower" ? ext.toLowerCase() : ext.toUpperCase()}`;
}

/** 模板模式：{name} {n} {ext} {date} */
function patternName(entry: Entry, i: number, pattern: string, start: number, pad: number): string {
  const { base, ext } = splitName(entry.name);
  const seq = String(start + i).padStart(pad, "0");
  let out = pattern
    .replace(/\{name\}/g, base)
    .replace(/\{n\}/g, seq)
    .replace(/\{ext\}/g, ext)
    .replace(/\{date\}/g, stamp(entry.modified));
  out = sanitize(out.trim());
  // 模板里没写扩展名就自动补回，避免把 .jpg 吃掉
  if (!pattern.includes("{ext}") && ext && !out.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    out = `${out}.${ext}`;
  }
  return out;
}

/** 查找替换模式：find 为空时原样返回；正则非法时标记 invalid。 */
function replaceName(
  entry: Entry,
  find: string,
  rep: string,
  regex: boolean,
  caseSensitive: boolean
): { name: string; invalid: boolean } {
  if (!find) return { name: entry.name, invalid: false };
  const flags = caseSensitive ? "g" : "gi";
  try {
    const re = regex ? new RegExp(find, flags) : new RegExp(escapeRe(find), flags);
    return { name: sanitize(entry.name.replace(re, rep)), invalid: false };
  } catch {
    return { name: entry.name, invalid: true };
  }
}

function readPresets(): Preset[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "[]");
    return Array.isArray(arr) ? (arr as Preset[]).slice(0, 12) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const { t, td } = useI18n();

  const demo = !isShell();
  const [dir, setDir] = useState(demo ? "D:/Photos/2024 旅行" : "");
  const [entries, setEntries] = useState<Entry[]>(demo ? DEMO_ENTRIES : []);
  const [selected, setSelected] = useState<Set<string>>(new Set(demo ? DEMO_ENTRIES.map((e) => e.name) : []));

  const [mode, setMode] = useState<Mode>("pattern");
  const [pattern, setPattern] = useState(demo ? "{date}-{n}" : "{name}");
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(2);

  const [find, setFind] = useState("");
  const [rep, setRep] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [extCase, setExtCase] = useState<ExtCase>("keep");

  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDesc, setSortDesc] = useState(false);
  const [includeDirs, setIncludeDirs] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [presets, setPresets] = useState<Preset[]>(readPresets);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const dirRef = useRef(dir);
  dirRef.current = dir;

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  const notify = useCallback((kind: "ok" | "bad", text: string) => setToast({ kind, text }), []);

  const load = useCallback(
    async (folder: string, withDirs: boolean) => {
      if (!isShell()) {
        notify("bad", t("选择一个文件夹开始"));
        return;
      }
      const list = await invoke<Entry[]>("list_entries", { dir: folder, includeDirs: withDirs }).catch(
        () => [] as Entry[]
      );
      setEntries(list);
      setSelected(new Set(list.map((e) => e.name)));
      setDir(folder);
    },
    [notify, t]
  );

  const pickFolder = useCallback(async () => {
    if (!isShell()) {
      notify("bad", t("选择一个文件夹开始"));
      return;
    }
    try {
      const picked = await openDialog({ directory: true, title: t("打开文件夹") });
      if (typeof picked === "string") await load(picked, includeDirs);
    } catch {
      /* 取消 */
    }
  }, [includeDirs, load, notify, t]);

  /* 排序：编号顺序跟随当前排序，所以「按拍摄时间编号」直接可用 */
  const sorted = useMemo(() => {
    const out = [...entries];
    const k = sortDesc ? -1 : 1;
    out.sort((a, b) => {
      if (sortKey === "size") return (a.size - b.size) * k;
      if (sortKey === "time") return (a.modified - b.modified) * k;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) * k;
    });
    return out;
  }, [entries, sortKey, sortDesc]);

  /* 预览：按当前排序 + 勾选顺序连续编号 */
  const preview = useMemo(() => {
    const existing = new Set(entries.map((e) => e.name));
    const chosen = sorted.filter((e) => selected.has(e.name));
    let invalid = false;
    const rows = chosen.map((e, i) => {
      let next: string;
      if (mode === "pattern") {
        next = patternName(e, i, pattern, start, pad);
      } else {
        const r = replaceName(e, find, rep, regex, caseSensitive);
        invalid = invalid || r.invalid;
        next = r.name;
      }
      next = applyExtCase(next, extCase);
      return { entry: e, next, conflict: "" as string };
    });

    const counts = new Map<string, number>();
    for (const r of rows) {
      const key = r.next.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const r of rows) {
      const key = r.next.toLowerCase();
      if ((counts.get(key) ?? 0) > 1) r.conflict = t("冲突：重名");
      else if (existing.has(r.next) && !selected.has(r.next)) r.conflict = t("冲突：已存在");
    }
    return { rows, invalid };
  }, [caseSensitive, entries, extCase, find, mode, pad, pattern, regex, rep, selected, sorted, start, t]);

  const changed = preview.rows.filter((r) => r.next && r.next !== r.entry.name);
  const conflicts = preview.rows.filter((r) => r.conflict).length;
  const shown = preview.rows.slice(0, ROW_LIMIT);

  const apply = useCallback(async () => {
    if (!isShell()) {
      notify("bad", t("选择一个文件夹开始"));
      return;
    }
    if (changed.length === 0) {
      notify("bad", t("没有需要改名的文件"));
      return;
    }
    if (conflicts > 0) {
      notify("bad", t("执行失败：{msg}", { msg: t("冲突：重名") }));
      return;
    }
    setBusy(true);
    try {
      const report = await invoke<Report>("rename_apply", {
        dir,
        pairs: changed.map((r) => ({ from: r.entry.name, to: r.next })),
      });
      setUndoDepth(report.undoDepth);
      if (report.errors.length > 0) {
        notify("bad", report.errors[0]);
      } else {
        notify("ok", t("改名完成：{n} 项", { n: report.renamed }));
      }
      await load(dir, includeDirs);
    } catch (e) {
      notify("bad", t("执行失败：{msg}", { msg: td(String(e)) }));
    } finally {
      setBusy(false);
    }
  }, [changed, conflicts, dir, includeDirs, load, notify, t, td]);

  const undo = useCallback(async () => {
    if (!isShell()) return;
    setBusy(true);
    try {
      const report = await invoke<Report>("rename_undo");
      setUndoDepth(report.undoDepth);
      notify("ok", t("已撤销"));
      await load(dirRef.current, includeDirs);
    } catch (e) {
      notify("bad", t("撤销失败：{msg}", { msg: td(String(e)) }));
    } finally {
      setBusy(false);
    }
  }, [includeDirs, load, notify, t, td]);

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /* ---------- 预设方案 ---------- */
  const savePreset = useCallback(() => {
    const label =
      mode === "pattern" ? pattern || t("模板") : `${find || "?"} → ${rep || "∅"}`;
    const item: Preset = { label, mode, pattern, find, rep, regex, start, pad };
    const next = [item, ...presets.filter((p) => p.label !== label)].slice(0, 12);
    setPresets(next);
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
    notify("ok", t("已保存预设"));
  }, [find, mode, notify, pad, pattern, presets, regex, rep, start, t]);

  const usePreset = useCallback((p: Preset) => {
    setMode(p.mode);
    setPattern(p.pattern);
    setFind(p.find);
    setRep(p.rep);
    setRegex(p.regex);
    setStart(p.start ?? 1);
    setPad(p.pad ?? 2);
  }, []);

  const dropPreset = useCallback((label: string) => {
    setPresets((prev) => {
      const next = prev.filter((p) => p.label !== label);
      try {
        localStorage.setItem(PRESET_KEY, JSON.stringify(next));
      } catch {
        /* 忽略 */
      }
      return next;
    });
  }, []);

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (undoDepth > 0 && !busy) void undo();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (!busy) void apply();
        return;
      }
      if (e.key.toLowerCase() === "a" && !typing) {
        e.preventDefault();
        setSelected(new Set(entries.map((x) => x.name)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, busy, entries, undo, undoDepth]);

  const winAction = useCallback(
    async (action: "minimize" | "maximize" | "close") => {
      if (!isShell()) return;
      try {
        if (action === "minimize") await invoke("win_minimize");
        else if (action === "close") await invoke("win_close");
        else await invoke("win_toggle_maximize");
      } catch (e) {
        notify("bad", t("窗口操作失败：{msg}", { msg: td(String(e)) }));
      }
    },
    [notify, t, td]
  );

  const dirName = dir ? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir : t("选择一个文件夹开始");

  const sortBtn = (key: SortKey, label: string) => (
    <button
      className={`sort${sortKey === key ? " on" : ""}`}
      onClick={() => {
        if (sortKey === key) setSortDesc((v) => !v);
        else {
          setSortKey(key);
          setSortDesc(false);
        }
      }}
    >
      {label}
      {sortKey === key && <i>{sortDesc ? "↓" : "↑"}</i>}
    </button>
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><i />SHADOWMOON <small>RENAME</small></div>
        <div className="now" title={dir}>{dirName}</div>
        <div className="spacer" data-tauri-drag-region />
        <button className="icon-btn" onClick={() => void pickFolder()}>{t("打开文件夹")}</button>
        <button className="icon-btn" onClick={() => void load(dir, includeDirs)} disabled={!dir}>
          {t("刷新")}
        </button>
        <PreferenceControls />
        <div className="win-controls">
          <button className="wc" aria-label={t("最小化")} onClick={() => void winAction("minimize")}><MinIcon /></button>
          <button className="wc" aria-label={t("最大化")} onClick={() => void winAction("maximize")}><MaxIcon /></button>
          <button className="wc close" aria-label={t("关闭")} onClick={() => void winAction("close")}><CloseIcon /></button>
        </div>
      </header>

      <div className="main">
        <section className="list-pane">
          <div className="list-head">
            <span className="label">{t("预览")}</span>
            <span className="mono n">{t("已选 {n} 项", { n: selected.size })}</span>
            <div className="spacer" />
            <span className="label">{t("排序")}</span>
            {sortBtn("name", t("名称"))}
            {sortBtn("time", t("时间"))}
            {sortBtn("size", t("大小"))}
            <span className="divider" />
            <button className="link" onClick={() => setSelected(new Set(entries.map((e) => e.name)))}>
              {t("全选")}
            </button>
            <button
              className="link"
              onClick={() =>
                setSelected((prev) => new Set(entries.filter((e) => !prev.has(e.name)).map((e) => e.name)))
              }
            >
              {t("反选")}
            </button>
          </div>

          <div className="table">
            <div className="tr head">
              <span />
              <span>{t("原名")}</span>
              <span />
              <span>{t("新名")}</span>
              <span>{t("大小")}</span>
            </div>
            {entries.length === 0 && (
              <div className="empty" onClick={() => void pickFolder()}>
                <div className="empty-ico"><DirIcon /></div>
                {t("选择一个文件夹开始")}
              </div>
            )}
            {shown.map((r) => (
              <div
                key={r.entry.path}
                className={`tr${r.conflict ? " bad" : ""}${r.next !== r.entry.name ? " changed" : ""}`}
              >
                <button
                  className={`box${selected.has(r.entry.name) ? " on" : ""}`}
                  onClick={() => toggle(r.entry.name)}
                  aria-label={t("全选")}
                >
                  {selected.has(r.entry.name) ? "✓" : ""}
                </button>
                <span className="cell old" title={r.entry.name}>
                  <span className="ico">{r.entry.isDir ? <DirIcon /> : <FileIcon />}</span>
                  {r.entry.name}
                </span>
                <span className="arrow">→</span>
                <span className="cell new" title={r.conflict || r.next}>
                  {r.next || "—"}
                  {r.conflict && <i className="warn">{r.conflict}</i>}
                </span>
                <span className="cell size mono">{r.entry.isDir ? "—" : fmtSize(r.entry.size)}</span>
              </div>
            ))}
            {preview.rows.length > shown.length && (
              <div className="more">{t("还有 {n} 项未显示", { n: preview.rows.length - shown.length })}</div>
            )}
            {preview.invalid && <div className="more bad">{t("非法正则")}</div>}
          </div>
        </section>

        <aside className="side">
          <div className="side-head">
            <div className="tabs">
              <button className={mode === "pattern" ? "on" : ""} onClick={() => setMode("pattern")}>
                {t("模板")}
              </button>
              <button className={mode === "replace" ? "on" : ""} onClick={() => setMode("replace")}>
                {t("查找替换")}
              </button>
            </div>
          </div>

          <div className="side-body">
            {mode === "pattern" ? (
              <>
                <div className="field">
                  <input
                    className="input mono"
                    value={pattern}
                    onChange={(e) => setPattern(e.target.value)}
                    placeholder="{name}"
                    spellCheck={false}
                  />
                  <div className="hint">
                    {t("可用变量")}：{DATE_TOKENS.map((k) => (
                      <code key={k}>{k}</code>
                    ))}
                  </div>
                </div>

                <div className="row2">
                  <div className="field">
                    <span className="label">{t("起始序号")}</span>
                    <input
                      className="input mono"
                      type="number"
                      min={0}
                      value={start}
                      onChange={(e) => setStart(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </div>
                  <div className="field">
                    <span className="label">{t("位数")}</span>
                    <input
                      className="input mono"
                      type="number"
                      min={1}
                      max={6}
                      value={pad}
                      onChange={(e) => setPad(Math.min(6, Math.max(1, Number(e.target.value) || 1)))}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <span className="label">{t("查找")}</span>
                  <input
                    className="input mono"
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    placeholder={regex ? "\\s*第(\\d+)集" : "IMG_"}
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <span className="label">{t("替换为")}</span>
                  <input
                    className="input mono"
                    value={rep}
                    onChange={(e) => setRep(e.target.value)}
                    placeholder={regex ? "S01E$1" : ""}
                    spellCheck={false}
                  />
                </div>
                <div className="row2">
                  <label className="check">
                    <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
                    <span>{t("正则")}</span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={caseSensitive}
                      onChange={(e) => setCaseSensitive(e.target.checked)}
                    />
                    <span>{t("区分大小写")}</span>
                  </label>
                </div>
                <div className="hint">{t("正则可用 $1 $2 引用捕获组，替换全部匹配项")}</div>
              </>
            )}

            <div className="field">
              <span className="label">{t("扩展名")}</span>
              <div className="seg wide">
                {(["keep", "lower", "upper"] as ExtCase[]).map((k) => (
                  <button key={k} className={extCase === k ? "on" : ""} onClick={() => setExtCase(k)}>
                    {k === "keep" ? t("保持原样") : k === "lower" ? t("小写") : t("大写")}
                  </button>
                ))}
              </div>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={includeDirs}
                onChange={(e) => {
                  setIncludeDirs(e.target.checked);
                  if (dir) void load(dir, e.target.checked);
                }}
              />
              <span>{t("包含子文件夹")}</span>
            </label>

            <div className="stat">
              <span className="mono">{t("已选 {n} 项", { n: changed.length })}</span>
              {conflicts > 0 && <span className="mono bad">{conflicts} × {t("冲突：重名")}</span>}
            </div>

            <button
              className="btn primary wide"
              disabled={busy || changed.length === 0 || conflicts > 0}
              onClick={() => void apply()}
              title="Ctrl+Enter"
            >
              {t("执行改名")}
            </button>
            <button className="btn wide" disabled={busy || undoDepth === 0} onClick={() => void undo()} title="Ctrl+Z">
              {undoDepth > 0 ? t("撤销（{n}）", { n: undoDepth }) : t("撤销上一次")}
            </button>

            <div className="example mono">
              {t("示例")}：IMG_0001.jpg →{" "}
              <b>
                {mode === "pattern"
                  ? patternName(
                      { name: "IMG_0001.jpg", path: "", isDir: false, size: 0, ext: "jpg", modified: 0 },
                      0,
                      pattern,
                      start,
                      pad
                    )
                  : replaceName(
                      { name: "IMG_0001.jpg", path: "", isDir: false, size: 0, ext: "jpg", modified: 0 },
                      find,
                      rep,
                      regex,
                      caseSensitive
                    ).name}
              </b>
            </div>

            <div className="field">
              <span className="label">
                {t("预设方案")}
                <button className="link" onClick={savePreset}>{t("保存当前")}</button>
              </span>
              <div className="presets">
                {presets.length === 0 && <span className="hint">{t("暂无预设")}</span>}
                {presets.map((p) => (
                  <span key={p.label} className="preset mono" title={p.label}>
                    <button className="preset-use" onClick={() => usePreset(p)}>{p.label}</button>
                    <button className="preset-x" aria-label={t("删除")} onClick={() => dropPreset(p.label)}>×</button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>

      {toast && (
        <div className="toast-wrap">
          <div className={`toast${toast.kind === "bad" ? " bad" : ""}`}>
            <b>{toast.kind === "bad" ? t("失败") : t("完成")}</b>
            {toast.text}
          </div>
        </div>
      )}
    </div>
  );
}
