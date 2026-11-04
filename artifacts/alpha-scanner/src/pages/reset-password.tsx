import { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { BrandLockup } from "@/components/brand";

export default function ResetPassword() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    if (newPassword.length < 6) {
      setError("Пароль должен быть не менее 6 символов");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code: code.trim(), newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data.error as string) ?? "Ошибка при сбросе пароля");
      } else {
        setDone(true);
      }
    } catch {
      setError("Нет соединения с сервером");
    }
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
            <CardTitle className="text-xl">Сброс пароля</CardTitle>
            <CardDescription>
              Получи код через Telegram-бот и задай новый пароль
            </CardDescription>
          </CardHeader>
          <CardContent>
            {done ? (
              <div className="text-center py-4 space-y-3">
                <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
                <p className="font-medium">Пароль успешно изменён!</p>
                <p className="text-sm text-muted-foreground">
                  Теперь можно войти с новым паролем.
                </p>
                <Link href="/login">
                  <Button variant="outline" className="mt-2">
                    Войти
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                {/* Инструкция */}
                <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-3 text-sm leading-relaxed text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground">
                    Как получить код:
                  </p>
                  <p>
                    1. Напиши{" "}
                    <span className="font-mono text-primary">
                      /resetpassword
                    </span>{" "}
                    боту{" "}
                    <a
                      href="https://t.me/CryptoAltHeroBot"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      @CryptoAltHeroBot
                    </a>{" "}
                    — код придёт в личный чат с ботом
                  </p>
                  <p>2. Введи полученный 6-значный код ниже</p>
                </div>

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
                    <label className="text-sm font-medium">Код из бота</label>
                    <Input
                      type="text"
                      placeholder="123456"
                      value={code}
                      onChange={(e) =>
                        setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      required
                      inputMode="numeric"
                      maxLength={6}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Новый пароль</label>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder="Минимум 6 символов"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        required
                        minLength={6}
                        autoComplete="new-password"
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

                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Повторите пароль
                    </label>
                    <div className="relative">
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder="Повторите пароль"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                        minLength={6}
                        autoComplete="new-password"
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
                    <p className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2">
                      {error}
                    </p>
                  )}

                  <Button type="submit" className="w-full" disabled={loading}>
                    {loading && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    Сбросить пароль
                  </Button>
                </form>

                <p className="mt-4 text-center text-sm text-muted-foreground">
                  <Link href="/login" className="text-primary hover:underline">
                    Вернуться ко входу
                  </Link>
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
