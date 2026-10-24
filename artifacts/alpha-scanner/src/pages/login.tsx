import { useState } from "react";
import { Link } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { BrandLockup } from "@/components/brand";

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    const err = await login(email, password);
    if (err) setError(err);
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Brand */}
        <div className="text-center space-y-2">
          <BrandLockup className="justify-center" />
          <p className="text-sm text-muted-foreground">Панель управления</p>
        </div>

        <Card className="border-border/50">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-xl">Вход</CardTitle>
            <CardDescription>Войдите в свой аккаунт</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Email</label>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Пароль</label>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
              {error && (
                <div className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2 space-y-1">
                  <p>{error}</p>
                  {error === "Доступ заблокирован" && (
                    <p className="text-muted-foreground">
                      Вы можете{" "}
                      <Link
                        href="/register"
                        className="text-primary hover:underline font-medium"
                      >
                        запросить доступ заново
                      </Link>
                      .
                    </p>
                  )}
                </div>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Войти
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Нет аккаунта?{" "}
              <Link href="/register" className="text-primary hover:underline">
                Запросить доступ
              </Link>
            </p>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              <Link
                href="/reset-password"
                className="text-primary hover:underline"
              >
                Забыли пароль?
              </Link>
            </p>
            <p className="mt-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-center text-xs leading-relaxed text-muted-foreground">
              Новым пользователям после оплаты нажмите «Запросить доступ» и
              пройдите регистрацию.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
