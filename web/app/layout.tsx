// Branchline fork modifications; see FORK.md.
import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Branchline',
  description: 'Claude Code and Codex session trees, live activity, and context monitoring',
  icons: { icon: '/icon.svg' },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased bg-[#0a0a1a]">
        {children}
      </body>
    </html>
  )
}
