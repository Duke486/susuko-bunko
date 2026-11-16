// 界面和逻辑全部在 ../app 的网页里，这里只是一个原生外壳。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start Susuko Bunko");
}
