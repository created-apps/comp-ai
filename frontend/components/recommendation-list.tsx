'use client'

/**
 * Renders a real recommendation run.
 *
 * The same component serves both personas — which is the point of the unified
 * pipeline — but the gating differs:
 *
 *  - TOF: the first card (CREST, pinned by the backend) is fully visible as the
 *    free sample; the rest arrive already redacted — the server strips them to a
 *    rank and a fit bucket until the lead gate is passed, so this component is
 *    rendering absence, not hiding data it was given.
 *  - ENROLLED: everything is visible and selectable up to the program allowance.
 *    A competition that is already active is shown as chosen and cannot be
 *    un-chosen here — activation is what created the student's workspace in
 *    COSMIC, so undoing it is an internal action, not a click.
 */

import { useState } from 'react'
import { Check, ExternalLink, Loader2, Lock, ShieldQuestion, Sparkles } from 'lucide-react'
import type { Persona, RecommendationItem, RecommendationPayload } from '@/lib/api'

const BUCKET_COPY: Record<RecommendationItem['fitBucket'], string> = {
  REACH: 'Reach',
  TARGET: 'Target',
  SAFETY: 'Safety',
}

/** A card's identity: the id an enrolled payload carries, else its slug. */
function refOf(item: RecommendationItem): string {
  return item.competition?.id ?? item.slug
}

export default function RecommendationList({
  payload,
  persona,
  allowance,
  activeIds = [],
  onConfirm,
  confirming = false,
  selectionError,
  onUnlock,
  unlocking = false,
  leadForm,
}: {
  payload: RecommendationPayload
  persona: Persona
  /** How many competitions this student's program lets them activate. */
  allowance?: number
  /** Competitions already activated — chosen, and not up for reconsideration. */
  activeIds?: string[]
  onConfirm?: (competitionIds: string[]) => void
  confirming?: boolean
  selectionError?: string
  onUnlock?: () => void
  unlocking?: boolean
  /** Rendered in place of the CTA once the student opens the gate. */
  leadForm?: React.ReactNode
}) {
  const [selected, setSelected] = useState<string[]>([])
  const limit = allowance ?? 2
  const lockedCount = payload.items.filter((i) => i.locked === true || !i.competition).length

  // The allowance is spent across every run, so what is left here is what the
  // student has not already committed elsewhere.
  const remaining = Math.max(0, limit - activeIds.length)
  const atLimit = selected.length >= remaining

  const toggle = (ref: string) =>
    setSelected((current) =>
      current.includes(ref)
        ? current.filter((s) => s !== ref)
        : current.length < remaining
          ? [...current, ref]
          : current,
    )

  return (
    <div>
      <div className="rounded-2xl border border-border bg-card p-5 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-5">
          <div>
            <p className="text-xs font-semibold text-muted-foreground">Your project</p>
            <p className="mt-1 text-sm leading-6">{payload.classification.summary}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {payload.classification.domains.join(' · ')} · {payload.classification.projectType} ·
              maturity {payload.classification.maturity.toLowerCase()}
              {payload.region ? ` · ${payload.region}` : ''}
            </p>
          </div>
          <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            {payload.items.length} {payload.items.length === 1 ? 'match' : 'matches'}
          </span>
        </div>

        {persona === 'ENROLLED' && (
          <p className="mt-5 text-xs text-muted-foreground">
            Your program includes {limit} {limit === 1 ? 'competition' : 'competitions'}.
            {activeIds.length > 0
              ? ` You have activated ${activeIds.length}${remaining > 0 ? `, and can choose ${remaining} more` : ''}.`
              : ' Choosing one'}
            {activeIds.length === 0
              ? ' sets it up in your CreatED workspace with its guidance, templates and deadline tracking — the rest stay here as recommendations.'
              : ''}
          </p>
        )}

        <div className="mt-5 flex flex-col gap-3">
          {payload.items.map((item, index) => {
            // The server redacts these before the gate, so a locked item has no
            // competition attached at all. `index > 0` is only the fallback for
            // an already-unlocked lead viewing their own report.
            const locked = item.locked === true || !item.competition
            return locked ? (
              <LockedCard key={`locked-${item.rank ?? index}`} item={item} />
            ) : (
              <OpenCard
                key={item.slug}
                item={item}
                persona={persona}
                selected={selected.includes(refOf(item)) || activeIds.includes(refOf(item))}
                active={activeIds.includes(refOf(item))}
                selectable={persona === 'ENROLLED'}
                disabled={
                  confirming ||
                  (atLimit && !selected.includes(refOf(item)) && !activeIds.includes(refOf(item)))
                }
                onToggle={() => toggle(refOf(item))}
              />
            )
          })}
        </div>

        {persona === 'TOF' && lockedCount > 0 && !leadForm && (
          <div className="mt-7 flex flex-col items-center gap-3 rounded-xl bg-primary/[.06] p-5 text-center">
            <p className="text-sm font-semibold">
              {lockedCount} more {lockedCount === 1 ? 'match' : 'matches'} for this project
            </p>
            <p className="max-w-md text-xs leading-6 text-muted-foreground">
              Share a few details and we will email you the full report — competition names,
              deadlines, eligibility and why each one fits your project.
            </p>
            <button
              onClick={onUnlock}
              disabled={unlocking}
              className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
            >
              {unlocking && <Loader2 className="size-4 animate-spin" />}
              Get my full report
            </button>
          </div>
        )}

        {/* The lead form, when the page has opened it. */}
        {leadForm}

        {persona === 'ENROLLED' && (
          <div className="mt-7 border-t border-border pt-5">
            <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
              <p className="text-xs text-muted-foreground">
                {remaining === 0
                  ? `All ${limit} of your competitions are active`
                  : `${selected.length} of ${remaining} selected`}
              </p>
              <button
                onClick={() => onConfirm?.(selected)}
                disabled={selected.length === 0 || confirming || !onConfirm}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40 sm:w-auto"
              >
                {confirming && <Loader2 className="size-4 animate-spin" />}
                Confirm my competitions
              </button>
            </div>
            {selectionError && (
              <p className="mt-3 text-center text-xs text-destructive sm:text-right">
                {selectionError}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function OpenCard({
  item,
  persona,
  selected,
  active = false,
  selectable,
  disabled = false,
  onToggle,
}: {
  item: RecommendationItem
  persona: Persona
  selected: boolean
  /** Already activated: chosen, and not something to undo from here. */
  active?: boolean
  selectable: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  const c = item.competition
  if (!c) return null

  // The masterlist is patchy. Saying "deadline not published" is honest; showing
  // a confident date we never verified is how a student misses one.
  const deadline = c.deadline.isRolling
    ? 'Rolling'
    : (c.deadline.text ?? 'Deadline not published')
  const unverified = c.deadline.lastVerifiedAt === null

  return (
    <article
      className={`rounded-xl border p-5 transition ${selected ? 'border-primary bg-primary/[.03]' : 'border-border'}`}
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-start">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold">{c.name}</h4>
            {item.pinned && (
              <span className="rounded-md bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary">
                <Sparkles className="mr-1 inline size-3" />
                Start here
              </span>
            )}
            <span className="rounded-md bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              {BUCKET_COPY[item.fitBucket]}
            </span>
          </div>

          <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.reason}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="rounded-md border border-border px-2 py-1">{deadline}</span>
            {c.eligibility && (
              <span className="rounded-md border border-border px-2 py-1">{c.eligibility}</span>
            )}
            {c.team && <span className="rounded-md border border-border px-2 py-1">{c.team}</span>}
            {c.difficulty && (
              <span className="rounded-md border border-border px-2 py-1">
                {c.difficulty.charAt(0) + c.difficulty.slice(1).toLowerCase()}
              </span>
            )}
          </div>

          {unverified && (
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-600">
              
            </p>
          )}

          {c.officialUrl && (
            <a
              href={c.officialUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary"
            >
              Official site <ExternalLink className="size-3" />
            </a>
          )}
        </div>

        <div className="flex items-center gap-5 md:w-40 md:flex-col md:items-end md:gap-2">
          {/* A pinned competition the model never scored has no fit percentage.
              Rendering its placeholder as "0%" would tell the student the free
              sample is a terrible match. */}
          {item.ranked !== false && item.score != null ? (
            <div className="text-left md:text-right">
              <p className="text-2xl font-semibold text-primary">{Math.round(item.score)}%</p>
              <p className="text-[10px] text-muted-foreground">project fit</p>
            </div>
          ) : (
            <div className="text-left md:text-right">
              <p className="text-sm font-semibold text-primary">Open to all</p>
              <p className="text-[10px] text-muted-foreground">no entry criteria to meet</p>
            </div>
          )}
          {selectable && (
            <button
              onClick={onToggle}
              disabled={disabled || active}
              className={`rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed ${
                selected
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-primary hover:bg-muted disabled:opacity-40'
              }`}
            >
              {active ? (
                <>
                  <Check className="mr-1 inline size-3.5" /> Active
                </>
              ) : selected ? (
                <>
                  <Check className="mr-1 inline size-3.5" /> Selected
                </>
              ) : (
                'Select'
              )}
            </button>
          )}
          {persona === 'TOF' && item.pinned && (
            <span className="text-[10px] font-semibold text-muted-foreground">Free sample</span>
          )}
        </div>
      </div>
    </article>
  )
}

/**
 * A locked card must not leak what it hides — no name, no link, no slug. It only
 * shows that a match exists, using the fit bucket the backend already returned.
 */
function LockedCard({ item }: { item: RecommendationItem }) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-dashed border-border p-5">
      <Lock className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        <div className="h-2.5 w-48 max-w-full rounded-full bg-muted" />
        <div className="mt-2.5 h-2 w-64 max-w-full rounded-full bg-muted/60" />
      </div>
      <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
        {BUCKET_COPY[item.fitBucket]}
      </span>
    </div>
  )
}
