import { Button, Tooltip } from "antd";
import { SquareTerminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface SessionTab {
  clientId: string;
  connectionId: string | null;
  endpoint: string;
  name: string;
}

interface SessionTabBarProps {
  connectionState: string;
  statusLabel: string;
  tab: SessionTab;
  closing: boolean;
  disabled: boolean;
  onClose(): void;
}

export function SessionTabBar({
  connectionState,
  statusLabel,
  tab,
  closing,
  disabled,
  onClose,
}: SessionTabBarProps) {
  const { t } = useTranslation();

  return (
    <div
      className="session-tabbar"
      role="tablist"
      aria-label={t("sessionTabs.label")}
    >
      <div
        className="session-tab is-active"
        role="tab"
        aria-selected="true"
        tabIndex={0}
        title={`${tab.name} — ${tab.endpoint}`}
      >
        <SquareTerminal size={13} aria-hidden="true" />
        <span
          className={`session-tab-status state-${connectionState}`}
          aria-hidden="true"
        />
        <span className="session-tab-summary">
          <strong>{tab.name}</strong>
          <span>{statusLabel}</span>
        </span>
        <Tooltip title={t("sessionTabs.closeNamed", { name: tab.name })}>
          <Button
            aria-label={t("sessionTabs.closeNamed", { name: tab.name })}
            className="session-tab-close"
            disabled={disabled}
            icon={<X size={12} />}
            loading={closing}
            size="small"
            type="text"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          />
        </Tooltip>
      </div>
    </div>
  );
}
