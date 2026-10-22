// Branchline fork modifications; see FORK.md.
import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Branchline',
  description: 'Claude Code and Codex session trees, live activity, and context monitoring',
  icons: {
    icon: [
      { url: '/icon-32.png?v=1', type: 'image/png', sizes: '32x32' },
      { url: '/icon.svg?v=1', type: 'image/svg+xml', sizes: 'any' },
    ],
    shortcut: '/favicon.ico?v=1',
    apple: { url: '/apple-touch-icon.png?v=1', sizes: '180x180' },
  },
  manifest: '/site.webmanifest?v=1',
}

export const viewport: Viewport = { themeColor: '#0a0a1a' }

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
