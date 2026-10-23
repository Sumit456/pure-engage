import { createBrowserRouter, RouterProvider, type RouteObject } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RequireAuth } from './auth/auth.tsx';
import { NAV, Shell } from './layout/Shell.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { ComingSoon } from './pages/ComingSoon.tsx';
import { Login } from './pages/Login.tsx';
import { ContactsPage } from './pages/contacts/ContactsPage.tsx';
import { ContactDetailPage } from './pages/contacts/ContactDetailPage.tsx';
import { ContactImportPage } from './pages/contacts/ContactImportPage.tsx';
import { TemplatesPage } from './pages/templates/TemplatesPage.tsx';
import { TemplateEditorPage } from './pages/templates/TemplateEditorPage.tsx';
import { MessagesPage } from './pages/messages/MessagesPage.tsx';
import { MessageDetailPage } from './pages/messages/MessageDetailPage.tsx';
import { SegmentEditorPage, SegmentsPage } from './pages/segments/SegmentsPage.tsx';
import { CampaignPage, CampaignsPage } from './pages/campaigns/CampaignsPage.tsx';
import { JourneysPage } from './pages/journeys/JourneysPage.tsx';
import { JourneyEditorPage } from './pages/journeys/JourneyEditorPage.tsx';
import { ReportsPage } from './pages/reports/ReportsPage.tsx';
import { SettingsPage } from './pages/settings/SettingsPage.tsx';
import { IntegrationsPage } from './pages/integrations/IntegrationsPage.tsx';
import { ApiKeysPage } from './pages/integrations/ApiKeysPage.tsx';
import { InboundEditorPage, InboundListPage } from './pages/integrations/InboundPages.tsx';
import { OutboundPage } from './pages/integrations/OutboundPage.tsx';
import { ApiReferencePage } from './pages/integrations/ApiReferencePage.tsx';
import { NoCodePage } from './pages/integrations/NoCodePage.tsx';
import { AiAssistantsPage } from './pages/integrations/AiAssistantsPage.tsx';
import { ConnectAuthorizePage } from './pages/integrations/ConnectAuthorizePage.tsx';

const BUILT = new Set(['dashboard', 'contacts', 'templates', 'messages', 'segments', 'campaigns', 'journeys', 'reports', 'settings', 'integrations']);

export const routes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  { path: '/connect/authorize', element: <RequireAuth><ConnectAuthorizePage /></RequireAuth> },
  {
    path: '/',
    element: <RequireAuth><Shell /></RequireAuth>,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'contacts', element: <ContactsPage /> },
      { path: 'contacts/import', element: <ContactImportPage /> },
      { path: 'contacts/:id', element: <ContactDetailPage /> },
      { path: 'templates', element: <TemplatesPage /> },
      { path: 'templates/:id', element: <TemplateEditorPage /> },
      { path: 'segments', element: <SegmentsPage /> },
      { path: 'segments/:id', element: <SegmentEditorPage /> },
      { path: 'campaigns', element: <CampaignsPage /> },
      { path: 'campaigns/:id', element: <CampaignPage /> },
      { path: 'journeys', element: <JourneysPage /> },
      { path: 'journeys/:id', element: <JourneyEditorPage /> },
      { path: 'messages', element: <MessagesPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'integrations/api', element: <ApiKeysPage /> },
      { path: 'integrations/inbound', element: <InboundListPage /> },
      { path: 'integrations/inbound/:id', element: <InboundEditorPage /> },
      { path: 'integrations/outbound', element: <OutboundPage /> },
      { path: 'integrations/reference', element: <ApiReferencePage /> },
      { path: 'integrations/no-code', element: <NoCodePage /> },
      { path: 'integrations/ai', element: <AiAssistantsPage /> },
      { path: 'messages/:id', element: <MessageDetailPage /> },
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
