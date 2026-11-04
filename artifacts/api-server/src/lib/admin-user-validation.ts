/**
 * Pure, framework-free validation helpers for the admin user management route.
 * Keeping them here makes them testable without importing the database or HTTP layer.
 */

export interface PasswordValidationError {
  valid: false;
  error: string;
}

export interface PasswordValidationOk {
  valid: true;
}

export type PasswordValidationResult =
  | PasswordValidationError
  | PasswordValidationOk;

/**
 * Validate an admin-supplied new password.
 *
 * Returns `{ valid: false, error }` when the value is present but too short,
 * or `{ valid: true }` otherwise (including when `newPassword` is `undefined`,
 * meaning the caller does not intend to change the password at all).
 */
export function validateNewPassword(
  newPassword: string | undefined,
): PasswordValidationResult {
  if (newPassword !== undefined && newPassword.length < 6) {
    return { valid: false, error: "Пароль: минимум 6 символов" };
  }
  return { valid: true };
}
