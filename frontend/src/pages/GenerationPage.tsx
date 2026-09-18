import { useMutation, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, CircleCheck, CircleDashed, CircleX, LoaderCircle, RefreshCw, SkipForward } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router'

import { api } from '../api/client'
import { queryKeys, useGeneration, usePresentation } from '../api/queries'
import type { Generation, Stage } from '../api/types'
import { PresentationHeader } from '../components/PresentationHeader'
import { Badge, Button, Card, EmptyState, ErrorState, FullPageSpinner, ProgressBar } from '../components/ui'
import { formatDuration } from '../lib/format'

const STAGE_ICONS: Record<Stage['status'], ReactNode> = {
  pending: <CircleDashed size={20} />,
  running: <LoaderCircle size={20} className="spin" />,
  done: <CircleCheck size={20} />,
  skipped: <SkipForward size={20} />,
  failed: <CircleX size={20} />,
}

function useElapsed(generation: Generation | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  const running = generation?.status === 'queued' || generation?.status === 'running'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [running])
  if (!generation?.started_at) return 0
  const end = generation.finished_at ? new Date(generation.finished_at).getTime() : now
  return end - new Date(generation.started_at).getTime()
}

export function GenerationPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const presentation = usePresentation(id)
  const generation = useGeneration(id)
  const elapsed = useElapsed(generation.data)
  const status = generation.data?.status

  // Когда генерация закончилась, обновляем статус презентации (для шагов и главной).
  useEffect(() => {
    if (status === 'done' || status === 'failed') {
      queryClient.invalidateQueries({ queryKey: queryKeys.presentation(id ?? '') })
      queryClient.invalidateQueries({ queryKey: queryKeys.presentations })
    }
  }, [status, id, queryClient])

  const restart = useMutation({
    mutationFn: () => api.post<Generation>(`/presentations/${id}/generate`),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.generation(id ?? ''), data)
      queryClient.invalidateQueries({ queryKey: queryKeys.presentation(id ?? '') })
    },
  })

  if (presentation.isPending) return <FullPageSpinner />
  if (presentation.error) return <ErrorState error={presentation.error} />

  const data = generation.data
  const header = <PresentationHeader presentation={presentation.data} step="generation" />

  if (generation.isPending) return <>{header}<FullPageSpinner /></>
  if (!data) {
    return (
      <div className="stack">
        {header}
        <EmptyState
          title="Генерация ещё не запускалась"
          action={<Button onClick={() => restart.mutate()} loading={restart.isPending}>Запустить генерацию</Button>}
        />
      </div>
    )
  }

  return (
    <div className="stack">
      {header}
      <div className="generation-layout">
        <Card className="generation-card">
          <div className="generation-card__top">
            <div>
              <h2>
                {status === 'done'
                  ? 'Готово: три варианта вёрстки'
                  : status === 'failed'
                    ? 'Генерация остановилась с ошибкой'
                    : status === 'queued'
                      ? 'Задача в очереди…'
                      : 'Генерируем презентацию…'}
              </h2>
              <p className="muted">
                {data.progress}% · {formatDuration(elapsed)} · лимит по ТЗ — 5 минут
              </p>
            </div>
            {status === 'done' && (
              <Button size="lg" icon={<ArrowRight size={18} />} onClick={() => navigate(`/presentations/${id}/variants`)}>
                Выбрать вариант
              </Button>
            )}
            {status === 'failed' && (
              <Button variant="secondary" icon={<RefreshCw size={16} />} loading={restart.isPending} onClick={() => restart.mutate()}>
                Повторить
              </Button>
            )}
          </div>
          <ProgressBar value={data.progress} />
          {data.error && <ErrorState error={new Error(data.error)} />}

          <ol className="stages">
            {data.stages.map((stage) => (
              <li key={stage.key} className={clsx('stage', `stage-${stage.status}`)}>
                <span className="stage__icon">{STAGE_ICONS[stage.status]}</span>
                <div className="stage__body">
                  <div className="stage__title">
                    <strong>{stage.title}</strong>
                    {stage.skill && <code>{stage.skill}</code>}
                  </div>
                  {stage.detail && <p>{stage.detail}</p>}
                </div>
                {stage.started_at && stage.finished_at && (
                  <small className="stage__time">
                    {formatDuration(new Date(stage.finished_at).getTime() - new Date(stage.started_at).getTime())}
                  </small>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <aside className="stack">
          <Card>
            <h3>Параметры запуска</h3>
            <dl className="summary-list">
              <div>
                <dt>Шаблон</dt>
                <dd>{presentation.data.template?.name ?? '—'}</dd>
              </div>
              <div>
                <dt>Слайдов</dt>
                <dd>{presentation.data.settings.slides_count}</dd>
              </div>
              <div>
                <dt>Файлов в контент-пакете</dt>
                <dd>{presentation.data.files.length}</dd>
              </div>
            </dl>
          </Card>
          <Card>
            <h3>Версии скиллов и агентов</h3>
            <p className="muted">Снимок фиксируется для каждого прогона — видно, какой версией пайплайна собрана колода.</p>
            <ul className="skills">
              {data.skills.map((skill) => (
                <li key={skill.name}>
                  <span>{skill.title}</span>
                  <span className="row">
                    <Badge tone={skill.runtime === 'mock' ? 'warning' : 'neutral'}>{skill.runtime}</Badge>
                    <code>v{skill.version}</code>
                  </span>
                </li>
              ))}
              {data.skills.length === 0 && <li className="muted">Появятся после старта воркера</li>}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  )
}
