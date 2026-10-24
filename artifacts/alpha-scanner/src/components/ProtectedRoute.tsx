import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";
import { isAuthenticated } from "@/hooks/useAuth";
import { ACCESS_REVOKED_EVENT } from "@/lib/authenticated-fetch";
import { captureClientError } from "@/lib/client-error-telemetry";

function clearSessionAndReturnToLogin(): void {
  localStorage.removeItem("authToken");
  localStorage.removeItem("adminToken");
  window.location.assign("/login");
}

export class ProtectedContentBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Dashboard render failed", error, info);
    captureClientError({
      kind: "render",
      error,
      component: info.componentStack ?? undefined,
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <AccessMessage
          title="Не удалось открыть кабинет"
          detail="Вход выполнен, но интерфейс не загрузился. Перезагрузите страницу или выполните вход заново."
          primaryLabel="Перезагрузить"
          onPrimary={() => window.location.reload()}
          secondaryLabel="Войти заново"
          onSecondary={clearSessionAndReturnToLogin}
        />
      );
    }
    return this.props.children;
  }
}

function AccessMessage({
  title,
  detail,
  primaryLabel,
  onPrimary,
  secondaryLabel,
  onSecondary,
  loading = false,
}: {
  title: string;
  detail: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  loading?: boolean;
}) {
  return (
    <main className="min-h-screen bg-background flex items-center justify-center p-4">
      <section className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-sm">
        {loading && (
          <Loader2 className="mx-auto mb-4 h-6 w-6 animate-spin text-primary" />
        )}
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
        {(primaryLabel || secondaryLabel) && (
          <div className="mt-5 flex flex-col gap-2">
            {primaryLabel && onPrimary && (
              <button
                type="button"
                onClick={onPrimary}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
              >
                {primaryLabel}
              </button>
            )}
            {secondaryLabel && onSecondary && (
              <button
                type="button"
                onClick={onSecondary}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground"
              >
                {secondaryLabel}
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [access, setAccess] = useState<
    "checking" | "granted" | "denied" | "unavailable"
  >(() => (isAuthenticated() ? "checking" : "denied"));

  useEffect(() => {
    const token = localStorage.getItem("authToken");
    if (!token) {
      setAccess("denied");
      return;
    }

    let disposed = false;
    const deny = () => {
      localStorage.removeItem("authToken");
      localStorage.removeItem("adminToken");
      setAccess("denied");
    };
    const validateAccess = () => {
      const currentToken = localStorage.getItem("authToken");
      if (!currentToken) {
        deny();
        return;
      }
      void fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${currentToken}` },
      })
        .then((response) => {
          if (disposed) return;
          if (response.ok) {
            setAccess("granted");
            return;
          }
          if (response.status === 401 || response.status === 403) {
            deny();
            return;
          }
          captureClientError({
            kind: "session_check",
            error: `Session check failed with HTTP ${response.status}`,
            httpStatus: response.status,
          });
          setAccess("unavailable");
        })
        .catch((error) => {
          if (!disposed) {
            captureClientError({ kind: "session_check", error });
            setAccess("unavailable");
          }
        });
    };
    const validateVisibleAccess = () => {
      if (document.visibilityState === "visible") validateAccess();
    };

    validateAccess();
    const interval = window.setInterval(validateAccess, 60_000);
    window.addEventListener(ACCESS_REVOKED_EVENT, deny);
    window.addEventListener("focus", validateAccess);
    document.addEventListener("visibilitychange", validateVisibleAccess);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener(ACCESS_REVOKED_EVENT, deny);
      window.removeEventListener("focus", validateAccess);
      document.removeEventListener("visibilitychange", validateVisibleAccess);
    };
  }, []);

  if (access === "denied") {
    return <Redirect to="/login" />;
  }
  if (access === "checking") {
    return (
      <AccessMessage
        loading
        title="Проверяем доступ"
        detail="Подождите несколько секунд — кабинет загружается."
      />
    );
  }
  if (access === "unavailable") {
    return (
      <AccessMessage
        title="Не удалось проверить доступ"
        detail="Соединение с сервером прервалось. Ваш аккаунт не заблокирован."
        primaryLabel="Повторить"
        onPrimary={() => window.location.reload()}
        secondaryLabel="Войти заново"
        onSecondary={clearSessionAndReturnToLogin}
      />
    );
  }
  return <ProtectedContentBoundary>{children}</ProtectedContentBoundary>;
}
