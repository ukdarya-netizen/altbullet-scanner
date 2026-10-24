declare global {
  interface Window {
    __showAltBulletBootstrapFailure?: (
      code?: "app_bootstrap_failed" | "browser_unsupported",
      appVersion?: string,
    ) => void;
    __markAltBulletBootstrapped?: () => void;
  }
}

export {};

function showBootstrapFailure(error: unknown): void {
  const errorCode = document.getElementById("bootstrap-error-code");
  const errorMessage = document.getElementById("bootstrap-error-message");
  const isSyntaxFailure =
    error instanceof SyntaxError ||
    (error instanceof Error && /syntax|unexpected token/i.test(error.message));

  if (errorMessage && isSyntaxFailure) {
    errorMessage.textContent =
      "Этот браузер не поддерживает текущую версию приложения. Обновите браузер или откройте страницу в Chrome, Safari или Firefox.";
  }
  if (errorCode) {
    errorCode.textContent = isSyntaxFailure
      ? "Код: browser_unsupported"
      : "Код: app_bootstrap_failed";
  }
  window.__showAltBulletBootstrapFailure?.(
    isSyntaxFailure ? "browser_unsupported" : "app_bootstrap_failed",
    __APP_VERSION__,
  );
}

async function bootstrap(): Promise<void> {
  await import("./index.css");
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { setAuthTokenGetter } = await import("@workspace/api-client-react");
  const { installAuthenticatedFetch } =
    await import("@/lib/authenticated-fetch");
  const { installGlobalErrorTelemetry } =
    await import("@/lib/client-error-telemetry");
  const { ProtectedContentBoundary } =
    await import("@/components/ProtectedRoute");
  const { default: App } = await import("./App");

  setAuthTokenGetter(() => {
    try {
      return localStorage.getItem("authToken");
    } catch {
      return null;
    }
  });
  installAuthenticatedFetch();
  installGlobalErrorTelemetry();

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Root element is unavailable");
  createRoot(rootElement).render(
    createElement(ProtectedContentBoundary, null, createElement(App)),
  );
  window.setTimeout(() => window.__markAltBulletBootstrapped?.(), 0);
}

void bootstrap().catch(showBootstrapFailure);
