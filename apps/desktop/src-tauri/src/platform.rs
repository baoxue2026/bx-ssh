use tauri::Webview;

#[tauri::command]
pub(crate) fn set_webview_memory_usage(webview: Webview, low: bool) -> Result<(), String> {
    set_platform_memory_usage(webview, low)
}

#[cfg(windows)]
fn set_platform_memory_usage(webview: Webview, low: bool) -> Result<(), String> {
    webview
        .with_webview(move |platform_webview| {
            use webview2_com::Microsoft::Web::WebView2::Win32::{
                ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
            };
            use windows::core::Interface;

            let Ok(core_webview) = (unsafe { platform_webview.controller().CoreWebView2() }) else {
                return;
            };
            let Ok(memory_controller) = core_webview.cast::<ICoreWebView2_19>() else {
                return;
            };
            let level = if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            let _ = unsafe { memory_controller.SetMemoryUsageTargetLevel(level) };
        })
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn set_platform_memory_usage(_webview: Webview, _low: bool) -> Result<(), String> {
    Ok(())
}
