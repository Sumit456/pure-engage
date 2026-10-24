import { createContext, useContext, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client.ts';
import type { Role, User } from '../api/types.ts';
import { Spinner } from '../components/ui.tsx';

const RANK: Record<Role, number> = { viewer: 0, marketer: 1, admin: 2 };
export const hasRole = (user: User | null | undefined, minimum: Role) => !!user && RANK[user.role] >= RANK[minimum];

const AuthContext = createContext<User | null>(null);

/** The signed-in user. Only use below <RequireAuth>. */
export function useUser(): User {
  const user = useContext(AuthContext);
  if (!user) throw new Error('useUser must be used inside <RequireAuth>');
  return user;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/api/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<{ user: User }>('/api/auth/login', { method: 'POST', body: input }),
    onSuccess: ({ user }) => qc.setQueryData(['me'], user),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <div className="pe-center"><Spinner /></div>;
  if (!me.data) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <AuthContext.Provider value={me.data}>{children}</AuthContext.Provider>;
}
