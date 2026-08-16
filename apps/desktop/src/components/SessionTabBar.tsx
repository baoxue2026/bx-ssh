import { useEffect, useRef, useState } from "react";
import { Button, Input, Tooltip, type InputRef } from "antd";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Pencil,
  SquareTerminal,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

export type SessionTabStatus =
  | "idle"
  | "probing"
  | "ready"
  | "connecting"
  | "connected"
  | "closing"
  | "disconnected"
  | "failed";

export interface SessionTab {
  clientId: string;
  connectionId: string | null;
  endpoint: string;
  name: string;
  status: SessionTabStatus;
  statusLabel: string;
}

interface SessionTabBarProps {
  activeClientId: string;
  closingClientId?: string;
  disabled?: boolean;
  tabs: SessionTab[];
  onClose(tab: SessionTab): void;
  onMove(tab: SessionTab, direction: "left" | "right"): void;
  onRename(tab: SessionTab, name: string): void;
  onSelect(tab: SessionTab): void;
}

export function SessionTabBar({
  activeClientId,
  closingClientId,
  disabled = false,
  tabs,
  onClose,
  onMove,
  onRename,
  onSelect,
}: SessionTabBarProps) {
  const { t } = useTranslation();
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const renameInputRef = useRef<InputRef>(null);

  useEffect(() => {
    if (editingClientId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [editingClientId]);

  const beginRename = (tab: SessionTab) => {
    if (disabled) return;
    setEditingClientId(tab.clientId);
    setEditingName(tab.name);
  };

  const commitRename = (tab: SessionTab) => {
    const name = editingName.trim();
    if (name && name !== tab.name) {
      onRename(tab, name);
    }
    setEditingClientId(null);
  };

  const cancelRename = () => setEditingClientId(null);

  return (
    <div
      className="session-tabbar"
      role="tablist"
      aria-label={t("sessionTabs.label")}
    >
      {tabs.map((tab, index) => {
        const active = tab.clientId === activeClientId;
        const editing = tab.clientId === editingClientId;
        const closeDisabled =
          disabled || closingClientId === tab.clientId || editing;
        return (
          <div
            className={`session-tab${active ? " is-active" : ""}`}
            key={tab.clientId}
            role="tab"
            aria-controls={`session-panel-${tab.clientId}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={`${tab.name} — ${tab.endpoint}`}
            onClick={() => onSelect(tab)}
            onDoubleClick={() => beginRename(tab)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(tab);
              } else if (event.key === "F2") {
                event.preventDefault();
                beginRename(tab);
              } else if (event.key === "Delete") {
                event.preventDefault();
                if (!closeDisabled) onClose(tab);
              }
            }}
          >
            <SquareTerminal size={13} aria-hidden="true" />
            <span
              className={`session-tab-status state-${tab.status}`}
              aria-hidden="true"
            />
            <span className="session-tab-summary">
              {editing ? (
                <Input
                  ref={renameInputRef}
                  aria-label={t("sessionTabs.renameNamed", {
                    name: tab.name,
                  })}
                  className="session-tab-rename-input"
                  size="small"
                  value={editingName}
                  onChange={(event) => setEditingName(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename(tab);
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => commitRename(tab)}
                />
              ) : (
                <>
                  <strong>{tab.name}</strong>
                  <span>{tab.statusLabel}</span>
                </>
              )}
            </span>
            {!editing && (
              <span className="session-tab-actions">
                <Tooltip
                  title={t("sessionTabs.renameNamed", { name: tab.name })}
                >
                  <Button
                    aria-label={t("sessionTabs.renameNamed", {
                      name: tab.name,
                    })}
                    className="session-tab-action"
                    disabled={disabled}
                    icon={<Pencil size={11} />}
                    size="small"
                    type="text"
                    onClick={(event) => {
                      event.stopPropagation();
                      beginRename(tab);
                    }}
                  />
                </Tooltip>
                <Tooltip title={t("sessionTabs.moveLeft")}>
                  <Button
                    aria-label={t("sessionTabs.moveLeftNamed", {
                      name: tab.name,
                    })}
                    className="session-tab-action"
                    disabled={disabled || index === 0}
                    icon={<ChevronLeft size={11} />}
                    size="small"
                    type="text"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(tab, "left");
                    }}
                  />
                </Tooltip>
                <Tooltip title={t("sessionTabs.moveRight")}>
                  <Button
                    aria-label={t("sessionTabs.moveRightNamed", {
                      name: tab.name,
                    })}
                    className="session-tab-action"
                    disabled={disabled || index === tabs.length - 1}
                    icon={<ChevronRight size={11} />}
                    size="small"
                    type="text"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMove(tab, "right");
                    }}
                  />
                </Tooltip>
              </span>
            )}
            <Tooltip title={t("sessionTabs.closeNamed", { name: tab.name })}>
              <Button
                aria-label={t("sessionTabs.closeNamed", { name: tab.name })}
                className="session-tab-close"
                disabled={closeDisabled}
                icon={<X size={12} />}
                loading={closingClientId === tab.clientId}
                size="small"
                type="text"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab);
                }}
              />
            </Tooltip>
            {editing && (
              <Tooltip title={t("sessionTabs.confirmRename")}>
                <Button
                  aria-label={t("sessionTabs.confirmRename")}
                  className="session-tab-action"
                  icon={<Check size={11} />}
                  size="small"
                  type="text"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    commitRename(tab);
                  }}
                />
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
}
