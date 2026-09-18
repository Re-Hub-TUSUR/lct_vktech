import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react'

import { api, ApiError, UNAUTHORIZED_EVENT } from '../api/client'
import { queryKeys } from '../api/queries'
import type { AuthResponse, User } from '../api/types'

interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<User>
  register: (fullName: string, email: string, password: string) => Promise<User>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

async function fetchMe(): Promise<User | null> {
  try {
    return await api.get<User>('/auth/me')
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { data, isPending } = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, staleTime: Infinity })

  const setUser = useCallback(
    (user: User | null) => {
      queryClient.setQueryData(queryKeys.me, user)
      // Данные прошлого пользователя не должны пережить выход. Запрос «me» не удаляем:
      // на нём держится наблюдатель сессии, иначе интерфейс не заметит выход.
      if (user === null) queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.me[0] })
    },
    [queryClient],
  )

  // Любой 401 от API (истекла сессия) возвращает на экран входа.
  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [setUser])

  const value = useMemo<AuthContextValue>(
    () => ({
      user: data ?? null,
      loading: isPending,
      login: async (email, password) => {
        const { user } = await api.post<AuthResponse>('/auth/login', { email, password })
        setUser(user)
        return user
      },
      register: async (fullName, email, password) => {
        const { user } = await api.post<AuthResponse>('/auth/register', { full_name: fullName, email, password })
        setUser(user)
        return user
      },
      logout: async () => {
        await api.post('/auth/logout').catch(() => undefined)
        setUser(null)
      },
    }),
    [data, isPending, setUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth должен использоваться внутри AuthProvider')
  return context
}
