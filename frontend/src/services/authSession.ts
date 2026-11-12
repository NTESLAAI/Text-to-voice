import { clearAuth, getAuthToken } from "./authStorage";

export async function expireSession(expectedToken?: string): Promise<void> {
  if (expectedToken !== undefined && (await getAuthToken()) !== expectedToken)
    return;
  await clearAuth();
  window.dispatchEvent(new Event("auth-session-expired"));
}
