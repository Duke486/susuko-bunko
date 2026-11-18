// 界面和逻辑全部在 ../app 的网页里，这里只是一个原生外壳。
// 另外提供一个给百度网盘“设备直连”用的原生下载命令：网页里的 fetch 不能设置 User-Agent，
// 也会被跨域限制挡住，所以由这里带着百度要求的请求头去下载，支持 Range 和跳转。
mod cloud;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(cloud::Http::new())
        .invoke_handler(tauri::generate_handler![cloud::cloud_range])
        .run(tauri::generate_context!())
        .expect("failed to start Susuko Bunko");
}
