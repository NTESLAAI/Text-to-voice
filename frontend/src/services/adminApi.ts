import api from "./api";

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  updatedAt: string;
  subscription: {
    id: string;
    status: string;
    startedAt: string;
    expiresAt: string;
    plan: {
      code: string;
      name: string;
      characterLimit: number;
      price: number;
      currency: string;
    };
    quotaGranted: number;
    quotaRemaining: number;
  } | null;
}

export async function getAdminUsers(): Promise<AdminUser[]> {
  const response = await api.get<AdminUser[]>("/users/admin");
  return response.data;
}
export async function resetAdminUser(userId: string) {
  const response = await api.post(`/users/admin/${userId}/reset`);
  return response.data;
}