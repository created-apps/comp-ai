'use client'

/**
 * Signup / login.
 *
 * Nothing here chooses a flow. The email is checked against the enrolled roster
 * on the backend — including a live sheet lookup — and the persona comes back on
 * the session. The same form produces an enrolled student or a public lead
 * depending only on that check.
 *
 * Signup asks for as little as possible: name, credentials, country. The rest of
 * the profile — phone, grade, school, city — is collected at the lead gate, once
 * the student has seen a real match worth trading details for.
 *
 * Country is the one profile-looking field asked here, and it is asked here
 * because it is not a profile field: it picks which region's competitions the
 * retriever searches. Asked at the gate it would arrive after the matches behind
 * that gate had already been built.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2 } from 'lucide-react'
import { login, signup, type Country } from '@/lib/api'

/**
 * Two options, because two is what the repository holds: the India and US
 * masterlists carry different eligibility text for the same competitions, and
 * there is no third list to match a third answer against.
 */
const COUNTRIES: { value: Country; label: string; hint: string }[] = [
  { value: 'India', label: 'India', hint: 'The India competition list' },
  { value: 'US', label: 'United States', hint: 'The US competition list' },
]

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'signup'>('login')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [country, setCountry] = useState<Country | ''>('')

  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (mode === 'signup' && !country) {
      setError('choose your country of citizenship')
      return
    }
    setBusy(true)
    setError('')
    try {
      if (mode === 'signup') {
        await signup({
          email,
          password,
          country: country as Country,
          ...(name.trim() ? { name: name.trim() } : {}),
        })
      } else {
        await login({ email, password })
      }
      router.push('/')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'something went wrong')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-5 py-10">
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-7"
      >
        <div className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          C
        </div>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {mode === 'login'
            ? 'Sign in to see your competition pathway.'
            : 'A few fields to start. We will ask for the rest only when it matters.'}
        </p>

        {mode === 'signup' && (
          <Field label="Your name" first>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Arshiya"
              className={inputClass}
            />
          </Field>
        )}

        <Field label="Email" first={mode === 'login'}>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            className={inputClass}
          />
        </Field>

        <Field label="Password">
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'signup' ? 'At least 10 characters' : 'Password'}
            className={inputClass}
          />
        </Field>

        {mode === 'signup' && (
          <fieldset className="mt-4">
            <legend className="text-xs font-semibold text-muted-foreground">
              What is your country of citizenship?
            </legend>
            <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
              This decides which competition list we match your project against.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {COUNTRIES.map((option) => (
                <label
                  key={option.value}
                  className={`cursor-pointer rounded-lg border p-3 transition ${
                    country === option.value
                      ? 'border-primary bg-primary/[.06]'
                      : 'border-border bg-card hover:bg-muted'
                  }`}
                >
                  <input
                    type="radio"
                    name="country"
                    required
                    checked={country === option.value}
                    onChange={() => setCountry(option.value)}
                    className="sr-only"
                  />
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
                    {option.hint}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {error && <p className="mt-4 text-xs font-medium text-destructive">{error}</p>}

        <button
          type="submit"
          disabled={busy || (mode === 'signup' && !country)}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {mode === 'login' ? 'Sign in' : 'Create account'}
          {!busy && <ArrowRight className="size-4" />}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login')
            setError('')
          }}
          className="mt-4 w-full text-center text-xs font-semibold text-primary"
        >
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>
      </form>
    </div>
  )
}

const inputClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none focus:border-primary'

function Field({
  label,
  children,
  first = false,
}: {
  label: string
  children: React.ReactNode
  first?: boolean
}) {
  return (
    <div className={first ? 'mt-5' : 'mt-4'}>
      <label className="block text-xs font-semibold text-muted-foreground">{label}</label>
      <div className="mt-2">{children}</div>
    </div>
  )
}
