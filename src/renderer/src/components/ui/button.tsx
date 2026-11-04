import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60 disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  { variants: {
    variant: {
      default: 'bg-orange-500 text-neutral-950 hover:bg-orange-400 shadow-[0_2px_15px_-8px_rgba(249,115,22,.75)]',
      secondary: 'bg-[var(--surface-2)] text-[var(--fg)] border border-[var(--border)] hover:bg-[var(--hover)]',
      ghost: 'text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)]',
      destructive: 'bg-red-600 text-white hover:bg-red-500'
    },
    size: { default: 'h-10 px-4 py-2', sm: 'h-8 px-3 text-xs', icon: 'h-9 w-9' }
  }, defaultVariants: { variant: 'default', size: 'default' } }
)
type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>
export const Button = forwardRef<HTMLButtonElement, Props>(function Button({ className, variant, size, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
})
