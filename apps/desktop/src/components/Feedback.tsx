import {
  Component,
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
  type ErrorInfo,
} from "react";
import {
  Alert,
  Button,
  Modal,
  Spin,
  type AlertProps,
  type ModalProps,
} from "antd";
import { useTranslation } from "react-i18next";

type DialogModalProps = Omit<
  ModalProps,
  | "afterOpenChange"
  | "children"
  | "closable"
  | "footer"
  | "keyboard"
  | "maskClosable"
  | "onCancel"
  | "open"
  | "panelRef"
  | "title"
>;

export interface AppDialogProps extends DialogModalProps {
  children?: ReactNode;
  closeOnEscape?: boolean;
  closable?: boolean;
  description?: ReactNode;
  descriptionId?: string;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  maskClosable?: boolean;
  onClose(): void;
  open: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  title: ReactNode;
}

export function AppDialog({
  children,
  closeOnEscape = true,
  closable = true,
  description,
  descriptionId,
  footer,
  initialFocusRef,
  maskClosable = false,
  onClose,
  open,
  returnFocusRef,
  title,
  ...modalProps
}: AppDialogProps) {
  const wasOpenRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const generatedDescriptionId = `${useId()}-description`;
  const resolvedDescriptionId =
    descriptionId ?? (description ? generatedDescriptionId : undefined);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      restoreFocusRef.current =
        returnFocusRef?.current ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null);
    }

    if (!open && wasOpenRef.current) {
      const target = returnFocusRef?.current ?? restoreFocusRef.current;
      if (target && target.isConnected && !target.hasAttribute("disabled")) {
        requestAnimationFrame(() => target.focus());
      }
    }

    wasOpenRef.current = open;
  }, [open, returnFocusRef]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (resolvedDescriptionId) {
      panel.setAttribute("aria-describedby", resolvedDescriptionId);
    } else {
      panel.removeAttribute("aria-describedby");
    }
  }, [open, resolvedDescriptionId]);

  const focusInitialControl = useCallback(() => {
    const explicitTarget = initialFocusRef?.current;
    if (explicitTarget && !explicitTarget.hasAttribute("disabled")) {
      explicitTarget.focus();
      return;
    }

    const firstControl =
      panelRef.current?.querySelector<HTMLElement>(
        '.ant-modal-body button:not([disabled]), .ant-modal-body input:not([disabled]), .ant-modal-body [tabindex="0"], .ant-modal-footer button:not([disabled])',
      ) ??
      panelRef.current?.querySelector<HTMLElement>(
        ".ant-modal-close:not([disabled])",
      );
    firstControl?.focus();
  }, [initialFocusRef]);

  const handleCancel = () => {
    if (closeOnEscape || closable || maskClosable) {
      onClose();
    }
  };

  return (
    <Modal
      {...modalProps}
      open={open}
      title={title}
      closable={closable}
      keyboard={closeOnEscape}
      maskClosable={maskClosable}
      panelRef={panelRef}
      footer={footer}
      onCancel={handleCancel}
      afterOpenChange={(visible) => {
        if (visible) {
          requestAnimationFrame(focusInitialControl);
        }
      }}
    >
      {description && (
        <p id={generatedDescriptionId} className="app-dialog-description">
          {description}
        </p>
      )}
      {children}
    </Modal>
  );
}

export type FeedbackNoticeProps = Omit<AlertProps, "aria-live" | "role"> & {
  live?: "assertive" | "polite";
};

export function FeedbackNotice({
  live,
  type = "info",
  ...props
}: FeedbackNoticeProps) {
  const resolvedLive = live ?? (type === "error" ? "assertive" : "polite");
  return (
    <Alert
      {...props}
      type={type}
      role={type === "error" ? "alert" : "status"}
      aria-live={resolvedLive}
    />
  );
}

interface LoadingStateProps {
  className?: string;
  label: string;
}

export function LoadingState({ className, label }: LoadingStateProps) {
  return (
    <div
      className={joinClasses("feedback-loading-state", className)}
      role="status"
      aria-busy="true"
      aria-live="polite"
    >
      <Spin size="small" />
      <span>{label}</span>
    </div>
  );
}

interface EmptyStateProps {
  action?: ReactNode;
  className?: string;
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}

export function EmptyState({
  action,
  className,
  description,
  icon,
  title,
}: EmptyStateProps) {
  return (
    <div
      className={joinClasses("feedback-empty-state", className)}
      role="status"
      aria-live="polite"
    >
      {icon && <span className="feedback-empty-icon">{icon}</span>}
      <span className="feedback-empty-title">{title}</span>
      {description && (
        <span className="feedback-empty-description">{description}</span>
      )}
      {action && <span className="feedback-empty-action">{action}</span>}
    </div>
  );
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Unhandled desktop UI error", {
      componentStack: errorInfo.componentStack,
      name: error.name,
    });
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }

    return this.props.children;
  }
}

function joinClasses(...classes: Array<string | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function DefaultErrorFallback({ onReload }: { onReload(): void }) {
  const { t } = useTranslation();

  return (
    <section className="app-error-fallback" role="alert" aria-live="assertive">
      <h1>{t("feedback.unexpectedError")}</h1>
      <p>{t("feedback.reloadDescription")}</p>
      <Button type="primary" onClick={onReload}>
        {t("feedback.reload")}
      </Button>
    </section>
  );
}
