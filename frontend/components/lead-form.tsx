'use client'

/**
 * The lead gate.
 *
 * Appears only after the student has seen a real match, so the exchange is
 * legible: here is one competition that fits, tell us who you are and we will
 * email you the rest.
 *
 * Country used to be asked here and is not any more. It selects the region the
 * retriever searches, so by the time this form is reached the answer can no
 * longer affect anything — the matches sitting behind the gate were already
 * built. It is asked at signup instead.
 */

import { useState } from 'react'
import { ArrowRight, Loader2, Mail } from 'lucide-react'
import type { LeadDetails } from '@/lib/api'

const GRADES = [5, 6, 7, 8, 9, 10, 11, 12]

export default function LeadForm({
  email,
  lockedCount,
  busy,
  error,
  defaultName,
  onSubmit,
  onCancel,
}: {
  email: string
  lockedCount: number
  busy: boolean
  error?: string
  defaultName?: string
  onSubmit: (details: LeadDetails) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(defaultName ?? '')
  const [phone, setPhone] = useState('')
  const [grade, setGrade] = useState('')
  const [school, setSchool] = useState('')
  const [city, setCity] = useState('')

  const ready = name.trim() && phone.trim() && grade && school.trim() && city.trim()

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!ready) return
    onSubmit({
      name: name.trim(),
      phone: phone.trim(),
      grade: Number(grade),
      school: school.trim(),
      city: city.trim(),
    })
  }

  return (
    <form
      onSubmit={submit}
      className="mt-7 rounded-xl border border-primary/30 bg-primary/[.04] p-5 md:p-6"
    >
      <div className="flex items-start gap-3">
        <Mail className="mt-0.5 size-4 shrink-0 text-primary" />
        <div>
          <p className="text-sm font-semibold">Get all {lockedCount + 1} matches by email</p>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">
            Competition names, deadlines, eligibility and why each one fits your project. We will
            send it to <span className="font-medium text-foreground">{email}</span>.
          </p>
        </div>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">Full name</span>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Arshiya Mehta"
            className={`mt-2 ${inputClass}`}
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">Phone number</span>
          <input
            required
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
            className={`mt-2 ${inputClass}`}
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">Grade</span>
          <select
            required
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            className={`mt-2 ${inputClass}`}
          >
            <option value="">Select…</option>
            {GRADES.map((g) => (
              <option key={g} value={g}>
                Grade {g}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-muted-foreground">City</span>
          <input
            required
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Mumbai"
            className={`mt-2 ${inputClass}`}
          />
        </label>

        <label className="block sm:col-span-2">
          <span className="text-xs font-semibold text-muted-foreground">School</span>
          <input
            required
            value={school}
            onChange={(e) => setSchool(e.target.value)}
            placeholder="Dhirubhai Ambani International School"
            className={`mt-2 ${inputClass}`}
          />
        </label>
      </div>

      {error && <p className="mt-4 text-xs font-medium text-destructive">{error}</p>}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-4 py-2.5 text-xs font-semibold text-muted-foreground"
        >
          Not now
        </button>
        <button
          type="submit"
          disabled={busy || !ready}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy && <Loader2 className="size-4 animate-spin" />}
          {busy ? 'Sending your report…' : 'Email me the full report'}
          {!busy && <ArrowRight className="size-4" />}
        </button>
      </div>
    </form>
  )
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary'
