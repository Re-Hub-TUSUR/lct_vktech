import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys } from '../api/queries'
import type { ProjectShareAccept } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { ErrorState, FullPageSpinner } from '../components/ui'

export function ProjectShareAcceptPage() {
  const { token } = useParams()
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const started = useRef(false)
  const accept = useMutation({
    mutationFn: () => api.post<ProjectShareAccept>(`/project-shares/${token}/accept`),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      navigate(`/presentations?project=${data.project_id}`, { replace: true })
    },
  })

  useEffect(() => {
    if (user && token && !started.current) {
      started.current = true
      accept.mutate()
    }
  }, [user, token, accept])

  if (loading) return <FullPageSpinner />
  if (!user) {
    return <Navigate to="/register" replace state={{ from: `/project-share/${token}`, shareRequired: true }} />
  }
  if (accept.error) {
    return (
      <main className="share-accept-page">
        <ErrorState error={accept.error} />
      </main>
    )
  }
  return <FullPageSpinner />
}
