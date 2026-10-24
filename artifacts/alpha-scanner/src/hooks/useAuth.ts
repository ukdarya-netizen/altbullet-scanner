import { useState, useCallback, useEffect } from "react";
import { useLocation } from "wouter";

export interface AuthUser {
  userId: number;
  email: string;
  name: string;
  role: "owner" | "user";
}

const TOKEN_KEY = "authToken";
const ADMIN_TOKEN_KEY = "adminToken";

function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeStoredValue(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // A restricted storage API should behave like an empty session.
  }
}

function writeStoredValue(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function decodeBase64UrlUtf8(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const bytes = Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

function decodeJwt(token: string): (AuthUser & { exp: number }) | null {
  try {
    const encodedPayload = token.split(".")[1];
    if (!encodedPayload) return null;
    const payload = JSON.parse(decodeBase64UrlUtf8(encodedPayload));
    return payload as AuthUser & { exp: number };
  } catch {
    return null;
  }
}

function isTokenAlive(token: string | null): boolean {
  if (!token) return false;
  const p = decodeJwt(token);
  return !!p && p.exp * 1000 > Date.now();
}

export function getStoredUser(): AuthUser | null {
  const token = readStoredValue(TOKEN_KEY);
  if (!isTokenAlive(token)) {
    if (token) removeStoredValue(TOKEN_KEY);
    return null;
  }
  const p = decodeJwt(token!);
  if (!p) return null;
  return {
    userId: p.userId,
    email: p.email,
    name: p.name,
    role: p.role ?? "user",
  };
}

export function isAuthenticated(): boolean {
  return isTokenAlive(readStoredValue(TOKEN_KEY));
}

export function clearAdminToken(): void {
  removeStoredValue(ADMIN_TOKEN_KEY);
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(() => getStoredUser());
  const [loading, setLoading] = useState(true);
  const [, navigate] = useLocation();

  useEffect(() => {
    setUser(getStoredUser());
    setLoading(false);
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<string | null> => {
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) return (data.error as string) ?? "Ошибка входа";
        if (!writeStoredValue(TOKEN_KEY, data.token as string)) {
          return "Браузер запретил сохранение входа. Откройте сайт в обычной вкладке браузера.";
        }
        const p = decodeJwt(data.token as string);
        if (p)
          setUser({
            userId: p.userId,
            email: p.email,
            name: p.name,
            role: p.role ?? "user",
          });
        navigate("/");
        return null;
      } catch {
        return "Нет соединения с сервером";
      }
    },
    [navigate],
  );

  const logout = useCallback(() => {
    removeStoredValue(TOKEN_KEY);
    removeStoredValue(ADMIN_TOKEN_KEY);
    setUser(null);
    navigate("/login");
  }, [navigate]);

  return { user, loading, login, logout };
}
