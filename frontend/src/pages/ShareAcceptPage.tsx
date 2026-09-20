import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys } from '../api/queries'
import type { ShareAccept } from '../api/types'
import { useAuth } from '../auth/AuthProvider'
import { ErrorState, FullPageSpinner } from '../components/ui'

export function ShareAcceptPage() {
  const { token } = useParams()
  const { user, loading } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const started = useRef(false)
  const accept = useMutation({
    mutationFn: () => api.post<ShareAccept>(`/shares/${token}/accept`),
    onSuccess: (share) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications })
      navigate(`/presentations/${share.presentation_id}`, { replace: true })
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
    return <Navigate to="/register" replace state={{ from: `/share/${token}`, shareRequired: true }} />
  }
  if (accept.error) return <main className="share-accept-page"><ErrorState error={accept.error} /></main>
  return <FullPageSpinner />
}
