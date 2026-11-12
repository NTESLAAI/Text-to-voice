import { Preferences } from "@capacitor/preferences";

import { Capacitor } from '@capacitor/core';
import { SecureStorage, KeychainAccess } from '@aparajita/capacitor-secure-storage';
import { Filesystem, Directory } from '@capacitor/filesystem';
const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";

export interface StoredUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  role: string;
}

export async function saveAuth(
  accessToken: string,
  user: StoredUser,
): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await SecureStorage.set(TOKEN_KEY, accessToken, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
    await Preferences.remove({ key: TOKEN_KEY });
  } else {
    await Preferences.set({ key: TOKEN_KEY, value: accessToken });
  }

  await Preferences.set({
    key: USER_KEY,
    value: JSON.stringify(user),
  });
}

export async function getAuthToken(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    await Preferences.remove({ key: TOKEN_KEY });
    const value = await SecureStorage.get(TOKEN_KEY, false, false);
    return typeof value === 'string' ? value : null;
  }
  const result = await Preferences.get({
    key: TOKEN_KEY,
  });

  return result.value;
}

export async function getAuthUser(): Promise<StoredUser | null> {
  const result = await Preferences.get({
    key: USER_KEY,
  });

  if (!result.value) {
    return null;
  }

  try {
    return JSON.parse(result.value) as StoredUser;
  } catch {
    return null;
  }
}

export async function clearAuth(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await SecureStorage.remove(TOKEN_KEY, false);
    await Filesystem.rmdir({ path: 'ttv-exports', directory: Directory.Cache, recursive: true }).catch(() => undefined);
  }
  await Preferences.remove({
    key: TOKEN_KEY,
  });

  await Preferences.remove({
    key: USER_KEY,
  });
}
