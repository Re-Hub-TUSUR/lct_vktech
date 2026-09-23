import { Navigate, Route, Routes, useParams } from 'react-router'

import { usePresentation } from './api/queries'
import { GuestOnly, RequireAuth } from './auth/guards'
import { AppLayout } from './components/AppLayout'
import { ErrorState, FullPageSpinner } from './components/ui'
import { presentationLink } from './lib/routes'
import { AuditPage } from './pages/AuditPage'
import { LoginPage } from './pages/auth/LoginPage'
import { RegisterPage } from './pages/auth/RegisterPage'
import { DashboardPage } from './pages/DashboardPage'
import { ExportPage } from './pages/ExportPage'
import { GenerationPage } from './pages/GenerationPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { PresentationSettingsPage } from './pages/PresentationSettingsPage'
import { TemplatePage } from './pages/TemplatePage'
import { TemplatesPage } from './pages/TemplatesPage'
import { VariantsPage } from './pages/VariantsPage'
import { ShareAcceptPage } from './pages/ShareAcceptPage'
import { MyPresentationsPage } from './pages/MyPresentationsPage'
import { ProjectShareAcceptPage } from './pages/ProjectShareAcceptPage'

function PresentationRedirect() {
  const { id } = useParams()
  const { data, error, isPending } = usePresentation(id)
  if (isPending) return <FullPageSpinner />
  if (error) return <ErrorState error={error} />
  return <Navigate to={presentationLink(data)} replace />
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
      <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
      <Route path="/share/:token" element={<ShareAcceptPage />} />
      <Route path="/share/project/:token" element={<ProjectShareAcceptPage />} />
      <Route path="/project-share/:token" element={<ProjectShareAcceptPage />} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="presentations" element={<MyPresentationsPage />} />
        <Route path="library" element={<Navigate to="/presentations" replace />} />
        <Route path="templates" element={<TemplatesPage />} />
        <Route path="templates/:templateId" element={<TemplatePage />} />
        <Route path="presentations/new" element={<PresentationSettingsPage />} />
        <Route path="presentations/:id" element={<PresentationRedirect />} />
        <Route path="presentations/:id/settings" element={<PresentationSettingsPage />} />
        <Route path="presentations/:id/generation" element={<GenerationPage />} />
        <Route path="presentations/:id/variants" element={<VariantsPage />} />
        <Route path="presentations/:id/audit" element={<AuditPage />} />
        <Route path="presentations/:id/export" element={<ExportPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  )
}
