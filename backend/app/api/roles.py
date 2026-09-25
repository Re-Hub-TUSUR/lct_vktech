"""Роли доступа к презентациям и папкам.

owner     — владелец (хранится в owner_id), единственный, кто может удалить объект;
coowner   — совладелец: всё, что владелец, кроме удаления; управляет участниками и ссылками;
editor    — редактор: меняет содержимое и генерирует, но не управляет доступом;
viewer    — наблюдатель: только просмотр и экспорт.
"""

EDIT_ROLES = frozenset({"owner", "coowner", "editor"})
MANAGE_ROLES = frozenset({"owner", "coowner"})

ROLE_LABELS = {
    "owner": "владелец",
    "coowner": "совладелец",
    "editor": "редактор",
    "viewer": "наблюдатель",
}


ROLE_PRIORITY: dict[str, int] = {
    "owner": 4,
    "coowner": 3,
    "editor": 2,
    "viewer": 1,
}


def role_label(role: str) -> str:
    return ROLE_LABELS.get(role, role)


def best_role(*roles: str | None) -> str | None:
    """Возвращает наивысшую роль из переданных."""
    valid = [r for r in roles if r in ROLE_PRIORITY]
    if not valid:
        return None
    return max(valid, key=lambda r: ROLE_PRIORITY[r])
