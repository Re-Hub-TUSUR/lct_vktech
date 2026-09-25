"""Числа в ячейках таблиц: какие столбцы числовые (их выравнивают по правому краю при сборке)."""

import re

from app.schemas.slide import TableData

# «1 250», «−3,5», «40%», «×96», «8 ч», «120 млн ₽», «+12 п.п.» — число с короткой единицей.
NUMBER_CELL_RX = re.compile(r"^[+\-−–]?[×x]?\d[\d\s  ]*(?:[.,]\d+)?(?:\s?(?:%|[^\W\d_]{1,5}\.?|₽|\$|€)){0,2}$")


def is_number(text: str) -> bool:
    return bool(NUMBER_CELL_RX.match(text.strip()))


def numeric_columns(table: TableData) -> set[int]:
    """Номера столбцов, где все непустые ячейки строк — числа (шапка не в счёт)."""
    width = max([len(table.columns), *(len(row) for row in table.rows)], default=0)
    numeric = set()
    for index in range(width):
        cells = [row[index].strip() for row in table.rows if index < len(row) and row[index].strip()]
        if cells and all(is_number(cell) for cell in cells):
            numeric.add(index)
    return numeric
