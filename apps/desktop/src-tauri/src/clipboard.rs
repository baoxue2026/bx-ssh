use crate::command_error::{CommandError, CommandErrorCode};

#[tauri::command]
#[specta::specta]
pub(crate) fn read_clipboard_text() -> Result<String, CommandError> {
    platform::read_text().map_err(|_| clipboard_error())
}

#[tauri::command]
#[specta::specta]
pub(crate) fn write_clipboard_text(text: String) -> Result<(), CommandError> {
    if text.contains('\0') {
        return Err(clipboard_error());
    }
    platform::write_text(&text).map_err(|_| clipboard_error())
}

fn clipboard_error() -> CommandError {
    CommandError::new(
        CommandErrorCode::ClipboardUnavailable,
        "the system text clipboard is unavailable",
    )
}

#[cfg(windows)]
mod platform {
    use std::{mem::size_of, ptr, slice};

    use windows::Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL},
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
                OpenClipboard, SetClipboardData,
            },
            Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
        },
    };

    const CF_UNICODE_TEXT: u32 = 13;
    const MAX_CLIPBOARD_TEXT_BYTES: usize = 16 * 1024 * 1024;

    struct ClipboardGuard;

    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            // SAFETY: this guard exists only after OpenClipboard succeeds.
            let _ = unsafe { CloseClipboard() };
        }
    }

    pub(super) fn read_text() -> Result<String, ()> {
        let _guard = open_clipboard()?;
        // SAFETY: the clipboard is open for this thread until _guard is dropped.
        if unsafe { IsClipboardFormatAvailable(CF_UNICODE_TEXT) }.is_err() {
            return Ok(String::new());
        }
        // SAFETY: the format is available and the clipboard remains open.
        let handle = unsafe { GetClipboardData(CF_UNICODE_TEXT) }.map_err(|_| ())?;
        let memory = HGLOBAL(handle.0);
        // SAFETY: GetClipboardData returned a valid global-memory handle.
        let byte_len = unsafe { GlobalSize(memory) };
        if byte_len == 0 || byte_len > MAX_CLIPBOARD_TEXT_BYTES {
            return Err(());
        }
        // SAFETY: the handle stays owned by the clipboard while it is open.
        let pointer = unsafe { GlobalLock(memory) } as *const u16;
        if pointer.is_null() {
            return Err(());
        }
        // SAFETY: GlobalSize bounds this UTF-16 view and the allocation stays locked.
        let units = unsafe { slice::from_raw_parts(pointer, byte_len / size_of::<u16>()) };
        let end = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let result = String::from_utf16(&units[..end]).map_err(|_| ());
        // SAFETY: this balances the successful GlobalLock call.
        let _ = unsafe { GlobalUnlock(memory) };
        result
    }

    pub(super) fn write_text(text: &str) -> Result<(), ()> {
        let _guard = open_clipboard()?;
        let wide = text
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let byte_len = wide.len().checked_mul(size_of::<u16>()).ok_or(())?;
        // SAFETY: byte_len is checked and the result is validated by GlobalAlloc.
        let memory = unsafe { GlobalAlloc(GMEM_MOVEABLE, byte_len) }.map_err(|_| ())?;
        // SAFETY: GlobalAlloc returned writable movable global memory.
        let pointer = unsafe { GlobalLock(memory) } as *mut u16;
        if pointer.is_null() {
            // SAFETY: ownership has not been transferred to the clipboard.
            let _ = unsafe { GlobalFree(Some(memory)) };
            return Err(());
        }
        // SAFETY: the allocation has exactly wide.len() UTF-16 units.
        unsafe { ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len()) };
        // SAFETY: this balances the successful GlobalLock call.
        let _ = unsafe { GlobalUnlock(memory) };
        // SAFETY: the clipboard is open and will take ownership only on success.
        if unsafe { EmptyClipboard() }.is_err()
            || unsafe { SetClipboardData(CF_UNICODE_TEXT, Some(HANDLE(memory.0))) }.is_err()
        {
            // SAFETY: SetClipboardData did not take ownership on failure.
            let _ = unsafe { GlobalFree(Some(memory)) };
            return Err(());
        }
        Ok(())
    }

    fn open_clipboard() -> Result<ClipboardGuard, ()> {
        // SAFETY: a null owner associates the clipboard with the current task.
        unsafe { OpenClipboard(None) }.map_err(|_| ())?;
        Ok(ClipboardGuard)
    }
}

#[cfg(not(windows))]
mod platform {
    pub(super) fn read_text() -> Result<String, ()> {
        Err(())
    }

    pub(super) fn write_text(_text: &str) -> Result<(), ()> {
        Err(())
    }
}

#[cfg(test)]
mod tests {
    use super::{clipboard_error, write_clipboard_text};
    use crate::command_error::CommandErrorCode;

    #[test]
    fn rejects_embedded_nulls_before_platform_access() {
        let error = write_clipboard_text("before\0after".to_owned()).unwrap_err();
        assert_eq!(error.code, CommandErrorCode::ClipboardUnavailable);
        assert_eq!(
            clipboard_error().code,
            CommandErrorCode::ClipboardUnavailable
        );
    }
}
