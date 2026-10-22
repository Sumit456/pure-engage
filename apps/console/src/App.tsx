import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequireAuth } from './auth/auth.tsx';
import { NAV, Shell } from './layout/Shell.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { ComingSoon } from './pages/ComingSoon.tsx';
import { Login } from './pages/Login.tsx';
import { ContactsPage } from './pages/contacts/ContactsPage.tsx';
import { ContactDetailPage } from './pages/contacts/ContactDetailPage.tsx';

const BUILT = new Set(['dashboard', 'contacts']);

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  {
    path: '/',
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'contacts/:id', element: <ContactDetailPage /> },
      ...NAV.filter((k) => !BUILT.has(k)).map((k) => ({ path: k, element: <ComingSoon section={k} /> })),
    ],
  },
];

export function createQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } } });
}

const router = createBrowserRouter(routes);
const queryClient = createQueryClient();

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
