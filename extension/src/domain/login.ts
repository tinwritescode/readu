// Rules of signing in with an emailed 6-digit code.

/** A code was sent to email at sentAt (ms). */
export interface PendingLogin {
  email: string;
  sentAt: number;
}

/** A code request that failed, possibly while no popup was open to show it. */
export interface LoginError {
  email: string;
  message: string;
  at: number;
}

/** Codes expire after 10 minutes on the server. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/** The server allows one code per email per minute. */
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const CODE_LENGTH = 6;

export function loginErrorText(status: number, error: string): string {
  if (status === 0) return 'Không kết nối được máy chủ.';
  if (status === 429) return 'Vui lòng đợi một phút rồi gửi lại mã.';
  if (status === 401) return 'Mã không đúng hoặc đã hết hạn.';
  if (status === 400) return 'Email không hợp lệ.';
  return error;
}
