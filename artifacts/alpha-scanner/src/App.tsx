import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { isAuthenticated, getStoredUser } from "@/hooks/useAuth";
const Dashboard = lazy(() => import("@/pages/dashboard"));
const Tracker = lazy(() => import("@/pages/tracker"));
const Candidates = lazy(() => import("@/pages/candidates"));
const Members = lazy(() => import("@/pages/members"));
const Analytics = lazy(() => import("@/pages/analytics"));
const PatternDebug = lazy(() => import("@/pages/pattern-debug"));
const BotHealth = lazy(() => import("@/pages/bot-health"));
const PatternReference = lazy(() => import("@/pages/pattern-reference"));
const HealthOutcomes = lazy(() => import("@/pages/health-outcomes"));
const TokenCharts = lazy(() => import("@/pages/token-charts"));
const BtcAnalysis = lazy(() => import("@/pages/btc-analysis"));
const Login = lazy(() => import("@/pages/login"));
const Register = lazy(() => import("@/pages/register"));
const ResetPassword = lazy(() => import("@/pages/reset-password"));
const Users = lazy(() => import("@/pages/users"));
const NotFound = lazy(() => import("@/pages/not-found"));
import { lazy, Suspense, useEffect, useState } from "react";

const queryClient = new QueryClient();

/** Redirect already-authenticated users away from login/register */
function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  if (isAuthenticated()) return <Redirect to="/" />;
  return <>{children}</>;
}

/** Redirect non-owners to home if they try to reach an owner-only page */
function OwnerRoute({ children }: { children: React.ReactNode }) {
  const stored = getStoredUser();
  if (!stored || stored.role !== "owner") return <Redirect to="/" />;
  return <>{children}</>;
}

function isTelegramMiniApp(): boolean {
  if (typeof window === "undefined") return false;

  const telegramWindow = window as Window & {
    Telegram?: { WebApp?: unknown };
  };
  const params = new URLSearchParams(window.location.search);
  const hasTelegramQuery = [
    "tgWebAppData",
    "tgWebAppVersion",
    "tgWebAppPlatform",
  ].some((key) => params.has(key));

  return (
    Boolean(telegramWindow.Telegram?.WebApp) ||
    hasTelegramQuery ||
    /Telegram/i.test(window.navigator.userAgent)
  );
}

function isCompactExperience(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.innerWidth < 768 || isTelegramMiniApp())
  );
}

function useCompactExperience() {
  const [compact, setCompact] = useState(isCompactExperience);

  useEffect(() => {
    const update = () => setCompact(isCompactExperience());
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    mediaQuery.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      mediaQuery.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return compact;
}

function HomeRoute() {
  return useCompactExperience() ? <Redirect to="/tracker" /> : <Dashboard />;
}

function Router() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
          Загрузка…
        </div>
      }
    >
      <Switch>
        {/* Public routes — no sidebar */}
        <Route path="/login">
          <PublicOnlyRoute>
            <Login />
          </PublicOnlyRoute>
        </Route>
        <Route path="/register">
          <PublicOnlyRoute>
            <Register />
          </PublicOnlyRoute>
        </Route>
        <Route path="/reset-password">
          <ResetPassword />
        </Route>

        {/* Users management — PIN-gated, no login required so owner can self-approve */}
        <Route path="/users">
          <Layout>
            <Users />
          </Layout>
        </Route>

        {/* All other routes — require auth + show sidebar */}
        <Route>
          <ProtectedRoute>
            <Layout>
              <Switch>
                <Route path="/" component={HomeRoute} />
                <Route path="/overview" component={Dashboard} />
                <Route path="/tracker" component={Tracker} />
                <Route path="/candidates" component={Candidates} />
                <Route path="/members">
                  <OwnerRoute>
                    <Members />
                  </OwnerRoute>
                </Route>
                <Route path="/subscribers">
                  <Redirect to="/members" />
                </Route>
                <Route path="/analytics">
                  <OwnerRoute>
                    <Analytics />
                  </OwnerRoute>
                </Route>
                <Route path="/pattern-debug">
                  <OwnerRoute>
                    <PatternDebug />
                  </OwnerRoute>
                </Route>
                <Route path="/bot-health">
                  <OwnerRoute>
                    <BotHealth />
                  </OwnerRoute>
                </Route>
                <Route path="/pattern-reference" component={PatternReference} />
                <Route path="/health-events">
                  <OwnerRoute>
                    <HealthOutcomes />
                  </OwnerRoute>
                </Route>
                <Route path="/btc" component={BtcAnalysis} />
                <Route path="/charts/:symbol">
                  {(params) => <TokenCharts symbol={params.symbol} />}
                </Route>
                <Route path="/charts" component={TokenCharts} />
                <Route path="/cancel-outcomes">
                  <Redirect to="/health-events" />
                </Route>
                <Route component={NotFound} />
              </Switch>
            </Layout>
          </ProtectedRoute>
        </Route>
      </Switch>
    </Suspense>
  );
}

function App() {
  useEffect(() => {
    document.documentElement.classList.add("dark");
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
