'use client'

/**
 * "Is this the project you want to continue with?"
 *
 * An enrolled family already has a project on the programme sheet, so we show
 * what we hold rather than handing them an empty form for work we know about.
 * It stays unconfirmed until they say so — our record of what they built is not
 * the same as their decision about what to take forward.
 */

import { FolderOpen, Loader2 } from 'lucide-react'
import type { PendingProject } from '@/lib/api'

export default function ProjectConfirm({
  project,
  studentName,
  busy,
  onConfirm,
  onDismiss,
}: {
  project: PendingProject
  studentName?: string
  busy: boolean
  onConfirm: () => void
  onDismiss: () => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-6 md:p-8">
      <div className="flex items-start gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <FolderOpen className="size-4" />
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-[.16em] text-primary">
            From your CreatED programme
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight">
            Is this the project you want to continue with?
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {studentName
              ? `This is what we have on record for ${studentName}.`
              : 'This is what we have on record for you.'}{' '}
            Confirm it and we will match competitions to it.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-border bg-background p-5">
        {project.name && <h3 className="font-semibold">{project.name}</h3>}
        {project.description && project.description !== project.name && (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{project.description}</p>
        )}
      </div>

      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="rounded-lg border border-border px-4 py-2.5 text-xs font-semibold text-muted-foreground disabled:opacity-40"
        >
          No — I want to work on something else
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          Yes, continue with this
        </button>
      </div>
    </div>
  )
}
