use serde::{Deserialize, Serialize};
use specta::Type;

use crate::{ConnectionSettings, SftpConflictAction};

pub const CURRENT_APPLICATION_SETTINGS_VERSION: u32 = 1;
pub const MIN_TERMINAL_FONT_SIZE: u8 = 10;
pub const MAX_TERMINAL_FONT_SIZE: u8 = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ApplicationLanguage {
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "en-US")]
    EnUs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemeMode {
    Light,
    Dark,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalFontFamily {
    CascadiaMono,
    CascadiaCode,
    Consolas,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalLineHeight {
    Compact,
    Standard,
    Relaxed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalCursorStyle {
    Block,
    Underline,
    Bar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TerminalColorScheme {
    BxDark,
    SolarizedDark,
    BxLight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct ApplicationSettings {
    pub version: u32,
    pub language: ApplicationLanguage,
    pub theme_mode: ThemeMode,
    pub confirm_close: bool,
    pub default_group_id: Option<String>,
    pub compact_layout: bool,
    pub terminal_font_family: TerminalFontFamily,
    pub terminal_font_size: u8,
    pub terminal_line_height: TerminalLineHeight,
    pub terminal_cursor_style: TerminalCursorStyle,
    pub terminal_cursor_blink: bool,
    pub terminal_color_scheme: TerminalColorScheme,
    pub multiline_paste_confirmation: bool,
    pub copy_on_select: bool,
    pub reconnect_confirmation: bool,
    pub sftp_default_local_directory: Option<String>,
    pub sftp_conflict_action: SftpConflictAction,
    pub external_link_confirmation: bool,
    pub exclude_credentials_from_export: bool,
    pub auto_check_updates: bool,
    pub log_level: LogLevel,
}

impl Default for ApplicationSettings {
    fn default() -> Self {
        Self {
            version: CURRENT_APPLICATION_SETTINGS_VERSION,
            language: ApplicationLanguage::ZhCn,
            theme_mode: ThemeMode::Dark,
            confirm_close: true,
            default_group_id: None,
            compact_layout: false,
            terminal_font_family: TerminalFontFamily::CascadiaMono,
            terminal_font_size: 13,
            terminal_line_height: TerminalLineHeight::Standard,
            terminal_cursor_style: TerminalCursorStyle::Block,
            terminal_cursor_blink: true,
            terminal_color_scheme: TerminalColorScheme::BxDark,
            multiline_paste_confirmation: true,
            copy_on_select: false,
            reconnect_confirmation: true,
            sftp_default_local_directory: None,
            sftp_conflict_action: SftpConflictAction::Ask,
            external_link_confirmation: true,
            exclude_credentials_from_export: true,
            auto_check_updates: true,
            log_level: LogLevel::Info,
        }
    }
}

impl ApplicationSettings {
    pub fn validate(&self) -> Result<(), ApplicationSettingsValidationError> {
        if self.version != CURRENT_APPLICATION_SETTINGS_VERSION {
            return Err(ApplicationSettingsValidationError::UnsupportedVersion);
        }
        if !(MIN_TERMINAL_FONT_SIZE..=MAX_TERMINAL_FONT_SIZE).contains(&self.terminal_font_size) {
            return Err(ApplicationSettingsValidationError::InvalidTerminalFontSize);
        }
        if self
            .default_group_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(ApplicationSettingsValidationError::InvalidDefaultGroup);
        }
        if self
            .sftp_default_local_directory
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err(ApplicationSettingsValidationError::InvalidLocalDirectory);
        }
        Ok(())
    }

    pub fn migrate(mut self) -> Result<Self, ApplicationSettingsValidationError> {
        if self.version > CURRENT_APPLICATION_SETTINGS_VERSION {
            return Err(ApplicationSettingsValidationError::UnsupportedVersion);
        }
        self.version = CURRENT_APPLICATION_SETTINGS_VERSION;
        self.validate()?;
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplicationSettingsValidationError {
    UnsupportedVersion,
    InvalidTerminalFontSize,
    InvalidDefaultGroup,
    InvalidLocalDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSettingsSnapshot {
    pub application: ApplicationSettings,
    pub application_initialized: bool,
    pub connection: ConnectionSettings,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_use_phase_one_values() {
        let settings = ApplicationSettings::default();

        settings.validate().unwrap();
        assert_eq!(settings.version, CURRENT_APPLICATION_SETTINGS_VERSION);
        assert_eq!(settings.terminal_font_size, 13);
        assert!(settings.confirm_close);
        assert!(settings.multiline_paste_confirmation);
        assert_eq!(settings.sftp_conflict_action, SftpConflictAction::Ask);
    }

    #[test]
    fn migrates_missing_fields_and_rejects_newer_versions() {
        let settings: ApplicationSettings =
            serde_json::from_str(r#"{"version":0,"themeMode":"light","terminalFontSize":16}"#)
                .unwrap();
        let migrated = settings.migrate().unwrap();

        assert_eq!(migrated.version, CURRENT_APPLICATION_SETTINGS_VERSION);
        assert_eq!(migrated.theme_mode, ThemeMode::Light);
        assert_eq!(migrated.terminal_font_size, 16);
        assert_eq!(migrated.log_level, LogLevel::Info);

        assert_eq!(
            ApplicationSettings {
                version: CURRENT_APPLICATION_SETTINGS_VERSION + 1,
                ..ApplicationSettings::default()
            }
            .migrate(),
            Err(ApplicationSettingsValidationError::UnsupportedVersion)
        );
    }

    #[test]
    fn rejects_invalid_editable_boundaries() {
        assert_eq!(
            ApplicationSettings {
                terminal_font_size: MIN_TERMINAL_FONT_SIZE - 1,
                ..ApplicationSettings::default()
            }
            .validate(),
            Err(ApplicationSettingsValidationError::InvalidTerminalFontSize)
        );
        assert_eq!(
            ApplicationSettings {
                default_group_id: Some(" ".to_owned()),
                ..ApplicationSettings::default()
            }
            .validate(),
            Err(ApplicationSettingsValidationError::InvalidDefaultGroup)
        );
    }
}
