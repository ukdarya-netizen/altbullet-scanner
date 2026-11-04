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

export default function Register() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [chatId, setChatId] = useState("");
  const [telegramUsername, setTelegramUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [done, setDone] = useState(false);
  const [autoApproved, setAutoApproved] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError("Пароли не совпадают");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          chatId,
          telegramUsername,
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError((data.error as string) ?? "Ошибка при регистрации");
      } else {
        setAutoApproved(!!data.autoApproved);
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
            <CardTitle className="text-xl">Запрос доступа</CardTitle>
            <CardDescription>
              Доступ открывается после проверки подписки
            </CardDescription>
          </CardHeader>
          <CardContent>
            {done ? (
              <div className="text-center py-4 space-y-3">
                <CheckCircle2 className="w-12 h-12 text-green-500 mx-auto" />
                {autoApproved ? (
                  <>
                    <p className="font-medium">Добро пожаловать!</p>
                    <p className="text-sm text-muted-foreground">
                      Аккаунт создан и сразу одобрен. Можно войти прямо сейчас.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="font-medium">Запрос отправлен!</p>
                    <p className="text-sm text-muted-foreground">
                      Администратор проверит вашу подписку и одобрит доступ.
                      После этого войдите с указанными email и паролем.
                    </p>
                  </>
                )}
                <Link href="/login">
                  <Button variant="outline" className="mt-2">
                    {autoApproved ? "Войти" : "Вернуться ко входу"}
                  </Button>
                </Link>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Имя и фамилия</label>
                  <Input
                    type="text"
                    placeholder="Иван Иванов"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoFocus
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Email</label>
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Telegram Chat ID{" "}
                      <span className="text-destructive">*</span>
                    </label>
                    <Input
                      type="text"
                      placeholder="123456789"
                      value={chatId}
                      onChange={(e) =>
                        setChatId(e.target.value.replace(/\D/g, ""))
                      }
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Ник в Telegram
                    </label>
                    <Input
                      type="text"
                      placeholder="@username"
                      value={telegramUsername}
                      onChange={(e) => setTelegramUsername(e.target.value)}
                    />
                  </div>
                </div>

                <p className="text-xs text-muted-foreground -mt-1">
                  <span className="text-red-400 font-medium">Chat ID</span>{" "}
                  можно узнать по кнопке в меню Telegram-бота{" "}
                  <a
                    href="https://t.me/CryptoAltHeroBot"
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary hover:underline"
                  >
                    @CryptoAltHeroBot
                  </a>
                </p>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Пароль для входа
                  </label>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      placeholder="Минимум 6 символов"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
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
                  {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Отправить запрос
                </Button>
              </form>
            )}
            {!done && (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                Уже есть аккаунт?{" "}
                <Link href="/login" className="text-primary hover:underline">
                  Войти
                </Link>
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
