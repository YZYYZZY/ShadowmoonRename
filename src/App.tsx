import { useCallback, useEffect, useMemo, useState } from "react";
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
}

interface Report {
  renamed: number;
  errors: string[];
  undoable: boolean;
}

const DEMO_ENTRIES: Entry[] = [
  { name: "IMG_0421.JPG", path: "D:////Photos////IMG_0421.JPG", isDir: false, size: 3_400_000, ext: "jpg" },
  { name: "IMG_0422.JPG", path: "D:////Photos////IMG_0422.JPG", isDir: false, size: 3_120_000, ext: "jpg" },
  { name: "Screenshot 2024-05-11.png", path: "D:////Photos////Screenshot.png", isDir: false, size: 840_000, ext: "png" },
  { name: "旅行 001.jpg", path: "D:////Photos////旅行 001.jpg", isDir: false, size: 5_100_000, ext: "jpg" },
];

type Toast = { kind: "ok" | "bad"; text: string } | null;

/** 文件名里不能出现的字符，统一替换成下划线。 */
function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+$/, "");
}

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

function buildName(
  entry: Entry,
  i: number,
  pattern: string,
  start: number,
  pad: number
): string {
  const { base, ext } = splitName(entry.name);
  const seq = String(start + i).padStart(pad, "0");
  let out = pattern
    .replace(/\{name\}/g, base)
    .replace(/\{n\}/g, seq)
    .replace(/\{ext\}/g, ext)
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  out = sanitize(out.trim());
  // 模板里没写扩展名就自动补回，避免把 .jpg 吃掉
  if (!/\{ext\}/.test(pattern) && ext && !out.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) {
    out = `${out}.${ext}`;
  }
  return out;
}

export default function App() {
  const { t, td } = useI18n();

  const demo = !isShell();
  const [dir, setDir] = useState(demo ? "D:////Photos////2024 旅行" : "");
  const [entries, setEntries] = useState<Entry[]>(demo ? DEMO_ENTRIES : []);
  const [selected, setSelected] = useState<Set<string>>(new Set(demo ? DEMO_ENTRIES.map((e) => e.name) : []));
  const [pattern, setPattern] = useState(demo ? "{date}-{n}" : "{name}");
  const [start, setStart] = useState(1);
  const [pad, setPad] = useState(2);
  const [includeDirs, setIncludeDirs] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

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

  /* 预览：按选中顺序（列表顺序）连续编号 */
  const preview = useMemo(() => {
    const existing = new Set(entries.map((e) => e.name));
    const chosen = entries.filter((e) => selected.has(e.name));
    const rows = chosen.map((e, i) => {
      const next = buildName(e, i, pattern, start, pad);
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
      else if (r.next === r.entry.name) r.conflict = "";
    }
    return rows;
  }, [entries, selected, pattern, start, pad, t]);

  const changed = preview.filter((r) => r.next !== r.entry.name);
  const conflicts = preview.filter((r) => r.conflict).length;

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
      setCanUndo(report.undoable);
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
    setBusy(true);
    try {
      const report = await invoke<Report>("rename_undo");
      setCanUndo(false);
      notify("ok", report.renamed > 0 ? t("已撤销") : t("没有需要改名的文件"));
      await load(dir, includeDirs);
    } catch (e) {
      notify("bad", t("撤销失败：{msg}", { msg: td(String(e)) }));
    } finally {
      setBusy(false);
    }
  }, [dir, includeDirs, load, notify, t, td]);

  const toggle = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

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
            {preview.map((r) => (
              <div key={r.entry.name} className={`tr${r.conflict ? " bad" : ""}${r.next !== r.entry.name ? " changed" : ""}`}>
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
                  {r.next}
                  {r.conflict && <i className="warn">{r.conflict}</i>}
                </span>
                <span className="cell size mono">{r.entry.isDir ? "—" : fmtSize(r.entry.size)}</span>
              </div>
            ))}
            {entries.length > preview.length && (
              <div className="more">+{entries.length - preview.length}</div>
            )}
          </div>
        </section>

        <aside className="side">
          <div className="side-head"><span className="label">{t("模板")}</span></div>

          <div className="side-body">
            <div className="field">
              <input
                className="input mono"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder="{name}"
                spellCheck={false}
              />
              <div className="hint">
                {t("可用变量")}：<code>{"{name}"}</code> <code>{"{n}"}</code> <code>{"{ext}"}</code>{" "}
                <code>{"{date}"}</code>
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

            <button className="btn primary wide" disabled={busy || changed.length === 0 || conflicts > 0} onClick={() => void apply()}>
              {t("执行改名")}
            </button>
            <button className="btn wide" disabled={busy || !canUndo} onClick={() => void undo()}>
              {t("撤销上一次")}
            </button>

            <div className="example mono">
              {t("示例")}：IMG_0001.jpg → <b>{buildName({ name: "IMG_0001.jpg", path: "", isDir: false, size: 0, ext: "jpg" }, 0, pattern, start, pad)}</b>
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
