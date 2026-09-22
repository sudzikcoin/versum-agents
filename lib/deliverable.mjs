import { COLUMNS } from './site-qa.mjs'

/**
 * Build the deliverable the client was promised: one row per defect, in their column names, with
 * the account of what was checked and what could not be reached attached as its own rows-free note.
 */
export function deliverableFrom(result, outputSpec) {
  const declared = (outputSpec?.columns ?? []).map((c) => c.name)
  const columns = declared.length ? declared : COLUMNS
  // functional first, then cosmetic — the task says not to mix them, so the table is ordered by it
  const order = { blocker: 0, major: 1, minor: 2, cosmetic: 3 }
  const rows = [...result.defects]
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'cosmetic' ? 1 : -1) || (order[a['приоритет']] ?? 9) - (order[b['приоритет']] ?? 9))
    .map((d) => {
      const row = {}
      for (const c of columns) row[c] = d[c] ?? ''
      return row
    })
  const notes = [
    `Проверено и работает: ${result.notes.join(' ')}`,
    result.uncovered.length ? `Не покрыто этим прогоном: ${result.uncovered.join(' ')}` : 'Непокрытых разделов нет.',
    `Дефектов: ${rows.length} (функциональных ${result.defects.filter((d) => d.kind !== 'cosmetic').length}, косметических ${result.defects.filter((d) => d.kind === 'cosmetic').length}).`,
  ].join('\n')
  return { kind: 'table', payload: { rows, notes } }
}

