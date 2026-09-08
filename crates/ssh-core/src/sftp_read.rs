use std::{fmt::Write as _, future::Future, io, sync::Arc};

use futures_util::{stream, StreamExt};
use russh_sftp::{
    client::{error::Error as SftpError, rawsession::Limits, Config, RawSftpSession},
    extensions,
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::{ConnectionCancellation, SshError};

// At most 2 MiB of read responses are buffered per transfer. All requests use
// one remote handle and bytes are consumed in offset order, even if replies do not.
const READ_AHEAD_REQUESTS: usize = 32;
const READ_RESPONSE_OVERHEAD: u64 = 9;

pub(crate) struct ReadAheadSession {
    session: Arc<RawSftpSession>,
    read_len: u32,
}

impl ReadAheadSession {
    pub(crate) async fn open<S>(stream: S, config: Config) -> Result<Self, SshError>
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let mut read_len = u64::from(config.max_packet_len).saturating_sub(READ_RESPONSE_OVERHEAD);
        let mut session = RawSftpSession::new_with_config(stream, config);
        let version = session.init().await?;
        if version
            .extensions
            .get(extensions::LIMITS)
            .is_some_and(|value| value == "1")
        {
            let limits = Limits::from(session.limits().await?);
            if let Some(limit) = limits.read_len {
                read_len = read_len.min(limit);
            }
            if let Some(limit) = limits.packet_len {
                read_len = read_len.min(limit.saturating_sub(READ_RESPONSE_OVERHEAD));
            }
            session.set_limits(limits);
        }
        if read_len == 0 {
            return Err(
                io::Error::new(io::ErrorKind::InvalidData, "invalid SFTP read limit").into(),
            );
        }
        Ok(Self {
            session: Arc::new(session),
            read_len: read_len as u32,
        })
    }

    pub(crate) async fn copy_to<W>(
        &self,
        path: &str,
        writer: &mut W,
        cancellation: Option<&ConnectionCancellation>,
        on_progress: &mut (dyn FnMut(u64) + Send),
    ) -> Result<(u64, String), SshError>
    where
        W: AsyncWrite + Unpin + Send,
    {
        let handle = self
            .session
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await?
            .handle;
        let file = ReadHandle {
            session: self.session.clone(),
            handle: Some(handle),
        };
        let handle = file.handle.as_deref().expect("newly opened handle");
        let read_at = |offset, len| async move {
            match self.session.read(handle, offset, len).await {
                Ok(data) => Ok(Some(data.data)),
                Err(SftpError::Status(status)) if status.status_code == StatusCode::Eof => Ok(None),
                Err(error) => Err(error.into()),
            }
        };
        let copy = copy_ordered(&read_at, writer, self.read_len, on_progress);
        let result = match cancellation {
            Some(cancellation) => tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(SshError::TransferCancelled),
                result = copy => result,
            },
            None => copy.await,
        };
        // Cancellation must return promptly even if the server stopped replying;
        // the drop guard releases that handle without blocking the caller.
        let result = result?;
        file.close().await?;
        Ok(result)
    }

    pub(crate) fn close(&self) -> Result<(), SshError> {
        self.session.close_session().map_err(Into::into)
    }
}

struct ReadHandle {
    session: Arc<RawSftpSession>,
    handle: Option<String>,
}

impl ReadHandle {
    async fn close(mut self) -> Result<(), SshError> {
        if let Some(handle) = self.handle.as_deref() {
            self.session.close(handle).await?;
            self.handle = None;
        }
        Ok(())
    }
}

impl Drop for ReadHandle {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let session = self.session.clone();
            // Also release the handle if the caller's future is dropped.
            tokio::spawn(async move {
                let _ = session.close(handle).await;
            });
        }
    }
}

struct ReadChunk {
    data: Vec<u8>,
    eof: bool,
}

async fn read_chunk<F, Fut>(read_at: &F, offset: u64, len: u32) -> Result<ReadChunk, SshError>
where
    F: Fn(u64, u32) -> Fut,
    Fut: Future<Output = Result<Option<Vec<u8>>, SshError>>,
{
    let mut data = Vec::new();
    while data.len() < len as usize {
        let next_offset = offset
            .checked_add(data.len() as u64)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "SFTP offset overflow"))?;
        let remaining = len - data.len() as u32;
        match read_at(next_offset, remaining).await? {
            None => return Ok(ReadChunk { data, eof: true }),
            Some(part) if part.is_empty() || part.len() > remaining as usize => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid SFTP read response length",
                )
                .into());
            }
            // SFTP permits short reads before EOF; fill the gap before advancing
            // to the next requested range, rather than silently skipping bytes.
            Some(part) if data.is_empty() => data = part,
            Some(part) => data.extend_from_slice(&part),
        }
    }
    Ok(ReadChunk { data, eof: false })
}

async fn copy_ordered<F, Fut, W>(
    read_at: &F,
    writer: &mut W,
    read_len: u32,
    on_progress: &mut (dyn FnMut(u64) + Send),
) -> Result<(u64, String), SshError>
where
    F: Fn(u64, u32) -> Fut,
    Fut: Future<Output = Result<Option<Vec<u8>>, SshError>>,
    W: AsyncWrite + Unpin,
{
    let chunks = stream::iter(0..=u64::MAX / u64::from(read_len))
        .map(|index| read_chunk(read_at, index * u64::from(read_len), read_len))
        .buffered(READ_AHEAD_REQUESTS);
    tokio::pin!(chunks);
    let mut bytes = 0_u64;
    let mut hasher = Sha256::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        writer.write_all(&chunk.data).await?;
        hasher.update(&chunk.data);
        bytes += chunk.data.len() as u64;
        on_progress(bytes);
        if chunk.eof {
            let mut sha256 = String::with_capacity(64);
            for byte in hasher.finalize() {
                write!(&mut sha256, "{byte:02x}").map_err(io::Error::other)?;
            }
            return Ok((bytes, sha256));
        }
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "SFTP file exceeds addressable size",
    )
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn preserves_order_and_short_reads_with_bounded_concurrency() {
        let data = (0..4099)
            .map(|value| (value % 251) as u8)
            .collect::<Vec<_>>();
        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let read_at = |offset: u64, len: u32| {
            let data = &data;
            let active = &active;
            let peak = &peak;
            async move {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                if offset == 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                } else {
                    tokio::task::yield_now().await;
                }
                active.fetch_sub(1, Ordering::SeqCst);
                let start = offset as usize;
                Ok((start < data.len())
                    .then(|| data[start..data.len().min(start + (len as usize).min(17))].to_vec()))
            }
        };
        let mut output = Vec::new();
        let mut progress = Vec::new();
        let (bytes, sha256) = copy_ordered(&read_at, &mut output, 128, &mut |bytes| {
            progress.push(bytes)
        })
        .await
        .unwrap();
        assert_eq!(output, data);
        assert_eq!(bytes, data.len() as u64);
        assert!(peak.load(Ordering::SeqCst) > 1);
        assert!(peak.load(Ordering::SeqCst) <= READ_AHEAD_REQUESTS);
        assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
        let expected = Sha256::digest(&data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(sha256, expected);
    }

    #[tokio::test]
    async fn rejects_empty_or_oversized_non_eof_responses() {
        for size in [0, 129] {
            let read_at = |_, _| std::future::ready(Ok(Some(vec![0; size])));
            let result = copy_ordered(&read_at, &mut tokio::io::sink(), 128, &mut |_| {}).await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn propagates_read_failure_without_writing_later_chunks() {
        let read_at = |offset, _| {
            std::future::ready(if offset == 0 {
                Err(io::Error::new(io::ErrorKind::ConnectionReset, "test disconnect").into())
            } else {
                Ok(Some(vec![1; 128]))
            })
        };
        let mut output = Vec::new();
        assert!(copy_ordered(&read_at, &mut output, 128, &mut |_| {})
            .await
            .is_err());
        assert!(output.is_empty());
    }

    #[tokio::test]
    async fn handles_empty_files_without_waiting_for_all_speculative_reads() {
        let read_at = |offset, _| async move {
            if offset == 0 {
                Ok(None)
            } else {
                std::future::pending().await
            }
        };
        let mut output = Vec::new();
        let (bytes, _) = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            copy_ordered(&read_at, &mut output, 128, &mut |_| {}),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(bytes, 0);
        assert!(output.is_empty());
    }

    #[tokio::test]
    async fn dropping_a_blocked_copy_releases_its_writer() {
        let (mut receiver, mut writer) = tokio::io::duplex(1);
        let read_at = |_, _| std::future::ready(Ok(Some(vec![1; 128])));
        let cancellation = ConnectionCancellation::default();
        let request = cancellation.clone();
        let job = tokio::spawn(async move {
            let mut on_progress = |_| {};
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(SshError::TransferCancelled),
                result = copy_ordered(&read_at, &mut writer, 128, &mut on_progress) => result,
            }
        });
        assert_eq!(receiver.read_u8().await.unwrap(), 1);
        request.cancel();
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), job)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(SshError::TransferCancelled)));
    }
}
