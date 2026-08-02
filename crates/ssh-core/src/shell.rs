use russh::{client, Channel, ChannelMsg};

use crate::SshError;

const TERMINAL_TYPE: &str = "xterm-256color";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    columns: u32,
    rows: u32,
    pixel_width: u32,
    pixel_height: u32,
}

impl TerminalSize {
    pub fn new(columns: u32, rows: u32) -> Result<Self, SshError> {
        Self::with_pixels(columns, rows, 0, 0)
    }

    pub fn with_pixels(
        columns: u32,
        rows: u32,
        pixel_width: u32,
        pixel_height: u32,
    ) -> Result<Self, SshError> {
        if columns == 0 || rows == 0 {
            return Err(SshError::InvalidTerminalSize);
        }

        Ok(Self {
            columns,
            rows,
            pixel_width,
            pixel_height,
        })
    }

    pub fn columns(&self) -> u32 {
        self.columns
    }

    pub fn rows(&self) -> u32 {
        self.rows
    }

    pub fn pixel_width(&self) -> u32 {
        self.pixel_width
    }

    pub fn pixel_height(&self) -> u32 {
        self.pixel_height
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEvent {
    Output(Vec<u8>),
    ExtendedOutput {
        stream: u32,
        data: Vec<u8>,
    },
    ExitStatus(u32),
    ExitSignal {
        signal: String,
        core_dumped: bool,
        message: String,
    },
    Eof,
    Closed,
}

pub struct SshShell {
    channel: Channel<client::Msg>,
}

impl SshShell {
    pub(crate) async fn open(
        mut channel: Channel<client::Msg>,
        size: TerminalSize,
    ) -> Result<Self, SshError> {
        channel
            .request_pty(
                true,
                TERMINAL_TYPE,
                size.columns,
                size.rows,
                size.pixel_width,
                size.pixel_height,
                &[],
            )
            .await?;
        await_request_reply(&mut channel, "PTY").await?;

        channel.request_shell(true).await?;
        await_request_reply(&mut channel, "shell").await?;

        Ok(Self { channel })
    }

    pub async fn write(&self, data: impl Into<Vec<u8>>) -> Result<(), SshError> {
        self.channel.data_bytes(data.into()).await?;
        Ok(())
    }

    pub async fn resize(&self, size: TerminalSize) -> Result<(), SshError> {
        self.channel
            .window_change(size.columns, size.rows, size.pixel_width, size.pixel_height)
            .await?;
        Ok(())
    }

    pub async fn next_event(&mut self) -> Result<ShellEvent, SshError> {
        loop {
            match self.channel.wait().await {
                Some(message) => {
                    if let Some(event) = map_channel_message(message) {
                        return Ok(event);
                    }
                }
                None => return Ok(ShellEvent::Closed),
            }
        }
    }

    pub async fn close(&self) -> Result<(), SshError> {
        self.channel.eof().await?;
        self.channel.close().await?;
        Ok(())
    }
}

async fn await_request_reply(
    channel: &mut Channel<client::Msg>,
    request: &'static str,
) -> Result<(), SshError> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => {
                return Err(SshError::ChannelRequestRejected { request });
            }
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                return Err(SshError::ChannelClosed { request });
            }
            Some(_) => {}
        }
    }
}

fn map_channel_message(message: ChannelMsg) -> Option<ShellEvent> {
    match message {
        ChannelMsg::Data { data } => Some(ShellEvent::Output(data.to_vec())),
        ChannelMsg::ExtendedData { data, ext } => Some(ShellEvent::ExtendedOutput {
            stream: ext,
            data: data.to_vec(),
        }),
        ChannelMsg::ExitStatus { exit_status } => Some(ShellEvent::ExitStatus(exit_status)),
        ChannelMsg::ExitSignal {
            signal_name,
            core_dumped,
            error_message,
            ..
        } => Some(ShellEvent::ExitSignal {
            signal: format!("{signal_name:?}"),
            core_dumped,
            message: error_message,
        }),
        ChannelMsg::Eof => Some(ShellEvent::Eof),
        ChannelMsg::Close => Some(ShellEvent::Closed),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalSize;
    use crate::SshError;

    #[test]
    fn validates_terminal_dimensions() {
        let size = TerminalSize::with_pixels(120, 36, 960, 720).unwrap();

        assert_eq!(size.columns(), 120);
        assert_eq!(size.rows(), 36);
        assert_eq!(size.pixel_width(), 960);
        assert_eq!(size.pixel_height(), 720);
        assert!(matches!(
            TerminalSize::new(0, 24),
            Err(SshError::InvalidTerminalSize)
        ));
        assert!(matches!(
            TerminalSize::new(80, 0),
            Err(SshError::InvalidTerminalSize)
        ));
    }
}
