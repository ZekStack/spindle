import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export function cn(...args: ClassValue[]): string { return twMerge(clsx(args)) }
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
export function readableDate(value?: string | null, language = 'en'): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.valueOf())
    ? date.toLocaleDateString(language === 'hu' ? 'hu-HU' : 'en-GB', { dateStyle: 'medium' })
    : '—'
}
