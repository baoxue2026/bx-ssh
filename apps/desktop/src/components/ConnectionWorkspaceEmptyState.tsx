import { Button } from "antd";
import { FileInput, Plus, Server, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConnectionListItem } from "../ipc/bindings";

interface ConnectionWorkspaceEmptyStateProps {
  language: string;
  loadingConnectionId?: string | null;
  recentConnections: ConnectionListItem[];
  totalConnections: number;
  onImportConfig(): void;
  onNewConnection(): void;
  onQuickConnect(item: ConnectionListItem): void;
}

export function ConnectionWorkspaceEmptyState({
  language,
  loadingConnectionId,
  recentConnections,
  totalConnections,
  onImportConfig,
  onNewConnection,
  onQuickConnect,
}: ConnectionWorkspaceEmptyStateProps) {
  const { t } = useTranslation();

  if (totalConnections === 0) {
    return (
      <section
        className="connection-workspace-empty"
        aria-label={t("connectionWorkspace.firstStartTitle")}
      >
        <span className="connection-workspace-empty-icon" aria-hidden="true">
          <SquareTerminal size={27} strokeWidth={1.45} />
        </span>
        <h2>{t("connectionWorkspace.firstStartTitle")}</h2>
        <p>{t("connectionWorkspace.firstStartDescription")}</p>
        <div className="connection-workspace-empty-actions">
          <Button
            aria-label={t("connectionWorkspace.firstStartAction")}
            type="primary"
            icon={<Plus size={15} />}
            onClick={onNewConnection}
          >
            {t("connectionEditor.actions.newConnection")}
          </Button>
          <Button icon={<FileInput size={15} />} onClick={onImportConfig}>
            {t("connectionWorkspace.importConfig")}
          </Button>
        </div>
        <span className="connection-workspace-empty-hint">
          {t("connectionWorkspace.importHelp")}
        </span>
      </section>
    );
  }

  return (
    <section
      className="connection-workspace-empty connection-workspace-idle"
      aria-label={t("connectionWorkspace.noSessionTitle")}
    >
      <span className="connection-workspace-empty-icon" aria-hidden="true">
        <SquareTerminal size={27} strokeWidth={1.45} />
      </span>
      <h2>{t("connectionWorkspace.noSessionTitle")}</h2>
      <p>{t("connectionWorkspace.noSessionDescription")}</p>
      {recentConnections.length > 0 ? (
        <div
          className="connection-workspace-recent"
          aria-label={t("connectionWorkspace.recentTitle")}
        >
          <strong>{t("connectionWorkspace.recentTitle")}</strong>
          {recentConnections.map((item) => (
            <article
              className="connection-workspace-recent-item"
              key={item.config.id}
            >
              <Server
                className="connection-workspace-recent-color"
                size={15}
                strokeWidth={1.6}
                style={
                  item.config.color ? { color: item.config.color } : undefined
                }
                aria-hidden="true"
              />
              <span className="connection-workspace-recent-summary">
                <strong>{item.config.name}</strong>
                <span>
                  {t("connectionWorkspace.recentMetadata", {
                    count: item.successfulConnectionCount,
                    time: formatRecentTime(item.lastConnectedAt, language),
                  })}
                </span>
              </span>
              <Button
                size="small"
                loading={loadingConnectionId === item.config.id}
                onClick={() => onQuickConnect(item)}
              >
                {t("connectionWorkspace.quickConnect")}
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <span className="connection-workspace-empty-hint">
          {t("connectionWorkspace.noRecent")}
        </span>
      )}
      <Button
        aria-label={t("connectionWorkspace.noSessionAction")}
        icon={<Plus size={15} />}
        onClick={onNewConnection}
      >
        {t("connectionEditor.actions.newConnection")}
      </Button>
      <Button icon={<FileInput size={15} />} onClick={onImportConfig}>
        {t("connectionWorkspace.importConfig")}
      </Button>
    </section>
  );
}

function formatRecentTime(value: number | null, language: string): string {
  if (value === null) return "—";
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
