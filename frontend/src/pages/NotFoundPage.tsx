import { Link } from 'react-router'

import { EmptyState } from '../components/ui'

export function NotFoundPage() {
  return (
    <div className="full-page-center">
      <EmptyState title="Страница не найдена" text="Проверьте адрес или вернитесь на главную." action={<Link to="/">На главную</Link>} />
    </div>
  )
}
