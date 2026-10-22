import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NAV, Shell } from './layout/Shell.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { ComingSoon } from './pages/ComingSoon.tsx';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } });

export const routes = [
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Dashboard /> },
      ...NAV.filter((k) => k !== 'dashboard').map((k) => ({ path: k, element: <ComingSoon section={k} /> })),
    ],
  },
];

const router = createBrowserRouter(routes);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
