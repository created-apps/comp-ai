'use client'

/**
 * Review one recommendation set — the destination of the "View competition
 * details" button in the internal notification email.
 *
 * Nothing here reaches the student until someone approves it, so this screen
 * exists to make that decision quickly: whose project, what was picked, why, and
 * what the pipeline dropped on the way.
 */

import { use, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, ShieldQuestion, X } from 'lucide-react'
import FullPageLoader from '@/components/full-page-loader'
import { admin, ApiError, type AdminReviewDetail } from '@/lib/api'

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [review, setReview] = useState<AdminReviewDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setReview(await admin.review(id))
    } catch (err) {
      // The email link can be opened by someone not signed into /admin yet.
      if (err instanceof ApiError && err.status === 401) router.push('/admin')
      else setError(err instanceof Error ? err.message : 'could not load this review')
    } finally {
      setLoading(false)
    }
  }, [id, router])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: 'approve' | 'reject') => {
    setBusy(true)
    setError('')
    try {
      if (action === 'approve') {
        await admin.approveReview(id, note || undefined)
        router.push('/admin')
        return
      }

      const result = await admin.rejectReview(id, note || undefined)
      // A replacement takes ~30s and arrives by email, so say what happens next
      // rather than dropping the reviewer back on an unchanged queue.
      if (!result.regenerating) {
        setError(`Rejected, but not regenerated: ${result.reason ?? 'unknown reason'}`)
        return
      }
      router.push('/admin')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not update this review')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <FullPageLoader />

  if (!review) {
    return (
      <div className="mx-auto max-w-3xl p-10">
        <p className="text-sm text-destructive">{error || 'Not found.'}</p>
        <Link href="/admin" className="mt-4 inline-block text-xs font-semibold text-primary">
          Back to admin
        </Link>
      </div>
    )
  }

  const student = review.project.student
  const decided = review.status !== 'PENDING_REVIEW'

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card px-5 py-5 md:px-10">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"
        >
          <ArrowLeft className="size-3.5" /> Admin
        </Link>
        <h1 className="mt-3 text-lg font-semibold tracking-tight">
          {student?.name ?? 'Student'} — {review.payload.items.length} competitions
        </h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {[student?.grade ? `Grade ${student.grade}` : null, student?.school, student?.country]
            .filter(Boolean)
            .join(' · ')}
          {decided && ` · already ${review.status.toLowerCase()}`}
        </p>
      </header>

      <main className="mx-auto max-w-3xl p-5 md:p-10">
        <section className="rounded-2xl border border-border bg-card p-5 md:p-6">
          <p className="text-xs font-semibold text-muted-foreground">Project</p>
          <h2 className="mt-1 font-semibold">{review.project.name ?? 'Unnamed project'}</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {review.project.description}
          </p>
        </section>

        <div className="mt-6 flex flex-col gap-3">
          {review.payload.items.map((item) => (
            <article key={item.slug} className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-semibold">{item.competition?.name ?? item.slug}</h3>
                <span className="rounded-md bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
                  {item.fitBucket}
                </span>
                {item.ranked !== false && item.score != null && (
                  <span className="text-xs font-semibold text-primary">
                    {Math.round(item.score)}% fit
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.reason}</p>
              <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-md border border-border px-2 py-1">
                  {item.competition?.deadline.isRolling
                    ? 'Rolling'
                    : (item.competition?.deadline.text ?? 'Deadline not published')}
                </span>
                {item.competition?.eligibility && (
                  <span className="rounded-md border border-border px-2 py-1">
                    {item.competition.eligibility}
                  </span>
                )}
              </div>
              {item.competition?.deadline.lastVerifiedAt === null && (
                <p className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-600">
                  <ShieldQuestion className="size-3.5" />
                  Dates never verified against the official source — check before approving.
                </p>
              )}
            </article>
          ))}
        </div>

        {!decided && (
          <div className="mt-8 rounded-2xl border border-border bg-card p-5 md:p-6">
            <label className="block text-xs font-semibold text-muted-foreground">
              Review note
            </label>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why these are wrong — e.g. “too many essay competitions, this is a hardware project”. On reject this is given to the ranker as a correction."
              className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2.5 text-sm leading-6 outline-none focus:border-primary"
            />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Rejecting regenerates a replacement set using this note. Without a note the new
              set is likely to look much like this one.
            </p>
            {error && <p className="mt-3 text-xs font-medium text-destructive">{error}</p>}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                onClick={() => void act('reject')}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-lg border border-border px-4 py-2.5 text-xs font-semibold text-muted-foreground disabled:opacity-40"
              >
                <X className="size-3.5" /> Reject and regenerate
              </button>
              <button
                onClick={() => void act('approve')}
                disabled={busy}
                className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
              >
                <Check className="size-4" /> Approve and release to the student
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
