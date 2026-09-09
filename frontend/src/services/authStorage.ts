import { Preferences } from '@capacitor/preferences';

const TOKEN_KEY = 'auth_token';
const USER_KEY = 'auth_user';

export interface StoredUser {
  id: string;
  email: string;
  name?: string | null;
}

export async function saveAuth(
  accessToken: string,
  user: StoredUser,
): Promise<void> {
  await Preferences.set({
    key: TOKEN_KEY,
    value: accessToken,
  });

  await Preferences.set({
    key: USER_KEY,
    value: JSON.stringify(user),
  });
}

export async function getAuthToken(): Promise<string | null> {
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
  await Preferences.remove({
    key: TOKEN_KEY,
  });

  await Preferences.remove({
    key: USER_KEY,
  });
}
