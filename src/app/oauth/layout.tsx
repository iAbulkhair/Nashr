// Root layout for the OAuth consent screen, which sits outside the [lang] layout and renders its own <html> and <body>.
// Turbopack builds without it, but webpack (`npm run build:hostinger`) refuses a page with no root layout.
export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
