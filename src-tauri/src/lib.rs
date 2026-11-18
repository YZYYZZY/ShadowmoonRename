/* Shadowmoon Rename · Rust 后端
 * 批量重命名：两阶段改名（先改成临时名，再改成目标名），避免 A→B、B→A 之类互相踩。
 * 每次成功执行都记下撤销表，支持一键回滚。
 */

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{State, Window};

/* ================= 窗口控制 ================= */

#[tauri::command]
fn win_minimize(window: Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_toggle_maximize(window: Window) -> Result<bool, String> {
    let maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn win_close(window: Window) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

/* ================= 共享偏好 ================= */

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
struct Prefs {
    theme: String,
    locale: String,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { theme: "dark".into(), locale: "zh".into() }
    }
}

fn prefs_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("Shadowmoon").join("prefs.json")
}

#[tauri::command]
fn prefs_get() -> Option<Prefs> {
    let text = fs::read_to_string(prefs_path()).ok()?;
    serde_json::from_str::<Prefs>(text.trim_start_matches('\u{feff}')).ok()
}

#[tauri::command]
fn prefs_set(prefs: Prefs) -> Result<(), String> {
    let normalized = Prefs {
        theme: match prefs.theme.as_str() {
            "light" | "system" => prefs.theme.clone(),
            _ => "dark".into(),
        },
        locale: if prefs.locale == "en" { "en".into() } else { "zh".into() },
    };
    let path = prefs_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

/* ================= 目录与改名 ================= */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    ext: String,
}

#[tauri::command]
fn list_entries(dir: String, include_dirs: bool) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir && !include_dirs {
            continue;
        }
        let meta = entry.metadata().ok();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        out.push(Entry {
            name: path.file_name().map(|x| x.to_string_lossy().to_string()).unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            is_dir,
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            ext,
        });
        if out.len() >= 2000 {
            break;
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[derive(Deserialize)]
struct Pair {
    from: String,
    to: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    renamed: u64,
    errors: Vec<String>,
    undoable: bool,
}

#[derive(Default)]
struct UndoState {
    dir: Mutex<String>,
    pairs: Mutex<Vec<(String, String)>>,
}

/* 两阶段改名：from → __sm_tmp_i → to。
 * 这样「1.txt → 2.txt」和「2.txt → 1.txt」同时存在也不会互相覆盖。 */
fn two_phase(dir: &Path, pairs: &[(String, String)]) -> Result<Vec<(String, String)>, Vec<String>> {
    let mut errors = Vec::new();
    let mut staged: Vec<(PathBuf, String, String)> = Vec::new(); // (tmp, to, from)

    for (i, (from, to)) in pairs.iter().enumerate() {
        let src = dir.join(from);
        if !src.exists() {
            errors.push(format!("源文件不存在：{from}"));
            continue;
        }
        let tmp = dir.join(format!(".sm_tmp_{i}_{from}"));
        if let Err(e) = fs::rename(&src, &tmp) {
            errors.push(format!("{from} → 临时名失败：{e}"));
            continue;
        }
        staged.push((tmp, to.clone(), from.clone()));
    }

    let mut done: Vec<(String, String)> = Vec::new();
    for (tmp, to, from) in staged {
        let dst = dir.join(&to);
        if dst.exists() {
            // 目标已存在：尽量退回原名
            let _ = fs::rename(&tmp, dir.join(&from));
            errors.push(format!("目标已存在：{to}"));
            continue;
        }
        match fs::rename(&tmp, &dst) {
            Ok(()) => done.push((from, to)),
            Err(e) => {
                let _ = fs::rename(&tmp, dir.join(&from));
                errors.push(format!("{from} → {to} 失败：{e}"));
            }
        }
    }

    if done.is_empty() && !errors.is_empty() {
        return Err(errors);
    }
    Ok(done)
}

#[tauri::command]
fn rename_apply(state: State<'_, Arc<UndoState>>, dir: String, pairs: Vec<Pair>) -> Result<Report, String> {
    let dir_path = PathBuf::from(&dir);
    if !dir_path.is_dir() {
        return Err("目录不可用".into());
    }
    let effective: Vec<(String, String)> = pairs
        .into_iter()
        .filter(|p| p.from != p.to && !p.to.trim().is_empty())
        .map(|p| (p.from, p.to))
        .collect();
    if effective.is_empty() {
        return Err("没有需要改名的文件".into());
    }

    let result = two_phase(&dir_path, &effective);
    let (done, errors) = match result {
        Ok(done) => (done, Vec::new()),
        Err(errors) => (Vec::new(), errors),
    };

    if !done.is_empty() {
        if let Ok(mut d) = state.dir.lock() {
            *d = dir.clone();
        }
        if let Ok(mut p) = state.pairs.lock() {
            *p = done.iter().map(|(from, to)| (to.clone(), from.clone())).collect();
        }
    }

    Ok(Report {
        renamed: done.len() as u64,
        errors,
        undoable: !done.is_empty(),
    })
}

/// 撤销上一次成功执行。
#[tauri::command]
fn rename_undo(state: State<'_, Arc<UndoState>>) -> Result<Report, String> {
    let dir = state.dir.lock().map(|g| g.clone()).unwrap_or_default();
    let pairs = state.pairs.lock().map(|g| g.clone()).unwrap_or_default();
    if dir.is_empty() || pairs.is_empty() {
        return Err("没有可撤销的操作".into());
    }

    let result = two_phase(Path::new(&dir), &pairs);
    let (done, errors) = match result {
        Ok(done) => (done, Vec::new()),
        Err(errors) => (Vec::new(), errors),
    };

    if !done.is_empty() {
        if let Ok(mut p) = state.pairs.lock() {
            p.clear();
        }
    }

    Ok(Report { renamed: done.len() as u64, errors, undoable: false })
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        std::process::Command::new("explorer").arg(&path).spawn().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("未找到".into())
    }
}

/* ================= 入口 ================= */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Arc::new(UndoState::default()))
        .invoke_handler(tauri::generate_handler![
            win_minimize,
            win_toggle_maximize,
            win_close,
            prefs_get,
            prefs_set,
            list_entries,
            rename_apply,
            rename_undo,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Shadowmoon Rename");
}

/* ================= 单元测试 ================= */

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join(".test-tmp")
            .join(format!("{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn swaps_two_names_without_overwrite() {
        let dir = tmp("swap");
        fs::write(dir.join("a.txt"), b"AAA").unwrap();
        fs::write(dir.join("b.txt"), b"BBB").unwrap();

        let done = two_phase(
            &dir,
            &[("a.txt".into(), "b.txt".into()), ("b.txt".into(), "a.txt".into())],
        )
        .unwrap();
        assert_eq!(done.len(), 2);
        assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "BBB");
        assert_eq!(fs::read_to_string(dir.join("b.txt")).unwrap(), "AAA");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_existing_target() {
        let dir = tmp("exist");
        fs::write(dir.join("x.txt"), b"1").unwrap();
        fs::write(dir.join("y.txt"), b"2").unwrap();
        let r = two_phase(&dir, &[("x.txt".into(), "y.txt".into())]);
        assert!(r.is_err());
        assert!(dir.join("x.txt").exists(), "失败时应退回原名");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renames_sequential_set() {
        let dir = tmp("seq");
        for i in 0..3 {
            fs::write(dir.join(format!("img{i}.jpg")), vec![i as u8]).unwrap();
        }
        let pairs: Vec<(String, String)> = (0..3)
            .map(|i| (format!("img{i}.jpg"), format!("照片-{}.jpg", i + 1)))
            .collect();
        let done = two_phase(&dir, &pairs).unwrap();
        assert_eq!(done.len(), 3);
        assert!(dir.join("照片-1.jpg").exists());
        assert!(dir.join("照片-3.jpg").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
